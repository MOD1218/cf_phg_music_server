// ==================== ScriptStorage（改造为委托 AppDataStore） ====================
// 原来直接读写 DB 的 'app_data' key，现在委托给统一的 AppDataStore。
// 所有写操作通过 AppDataStore.update() 串行化，避免竞态。

import { AppDataStore, type AppData, type ScriptInfo, type ScriptStats, type SourceStats, type CircuitBreakerState } from './app_data.ts';

// 重新导出类型，保持 index.ts 的 import 不变
export type { ScriptInfo, ScriptStats, SourceStats, CircuitBreakerState };
export type ScriptStatsData = Record<string, ScriptStats>;
export type ScriptSourceStats = Record<string, Record<string, SourceStats>>;
export type CircuitBreakerData = Record<string, CircuitBreakerState>;

const ALL_SOURCES = ['kw', 'kg', 'tx', 'wy', 'mg'] as const;
const MIN_SAMPLES = 5;
const EPSILON = 0.05;
const CIRCUIT_BREAKER_THRESHOLD = 3;
const COOLDOWN_LEVELS_MIN = [3, 10, 30, 60, 120]; // 指数退避冷却(分钟): 3min->10min->30min->1h->2h
function getCooldownMs(tripCount: number): number {
  const level = Math.min(tripCount - 1, COOLDOWN_LEVELS_MIN.length - 1);
  return COOLDOWN_LEVELS_MIN[level] * 60 * 1000;
}

export class ScriptStorage {
  private store: AppDataStore;

  constructor(db: D1Database, sharedStore?: AppDataStore) {
    this.store = sharedStore ?? new AppDataStore(db);
  }

  /** 获取底层 AppDataStore（供 index.ts 共享同一实例） */
  getStore(): AppDataStore {
    return this.store;
  }

  private async getData(): Promise<AppData> {
    return await this.store.get();
  }

  /** 兼容旧接口：flush 现在是 no-op（所有写操作已通过 update 即时落盘） */
  async flush(): Promise<void> {
    // no-op: AppDataStore.update() 已即时写入 DB
  }

  async importScriptFromUrl(url: string): Promise<ScriptInfo> {
    if (!/^https?:\/\//.test(url)) throw new Error("无效的URL格式");
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`下载失败: ${response.status}`);
    const script = await response.text();
    return this.importScriptInternal(script, url);
  }

  async importScriptRaw(name: string, content: string, url: string = ''): Promise<ScriptInfo> {
    let scriptContent = content;
    try { scriptContent = atob(content); } catch (_e) {}
    return this.importScriptInternal(scriptContent, url, name);
  }

  private async importScriptInternal(scriptContent: string, url: string = '', overrideName?: string): Promise<ScriptInfo> {
    const scriptInfo = this.parseScriptInfo(scriptContent);
    let supportedSources = this.parseSupportedSources(scriptContent);
    if (supportedSources.length === 0 || (supportedSources.length === 1 && supportedSources[0] === 'unknown')) {
      supportedSources = ['kw', 'kg', 'tx', 'wy', 'mg'];
    }

    let resultItem!: ScriptInfo;
    await this.store.update(data => {
      const isFirstScript = data.scripts.length === 0;
      const now = Date.now();
      const item: ScriptInfo = {
        ...scriptInfo,
        name: overrideName || scriptInfo.name,
        scriptUrl: url,
        isDefault: isFirstScript,
        supportedSources,
        rawScript: scriptContent,
        createdAt: now,
        updatedAt: now,
      };
      data.scripts.push(item);
      if (isFirstScript) {
        data.default_source_id = item.id;
      }
      resultItem = item;
    });
    return resultItem;
  }

  async getScripts(): Promise<ScriptInfo[]> {
    const data = await this.getData();
    return data.scripts.map(s => ({
      ...s,
      isDefault: s.id === data.default_source_id,
    }));
  }

  async getScript(id: string): Promise<ScriptInfo | null> {
    const data = await this.getData();
    const s = data.scripts.find(s => s.id === id);
    if (!s) return null;
    return { ...s, isDefault: s.id === data.default_source_id };
  }

  async getScriptRaw(id: string): Promise<string | null> {
    let rawScript: string | null = null;
    await this.store.update(data => {
      const s = data.scripts.find(s => s.id === id);
      if (!s) return;
      if (s.rawScript) { rawScript = s.rawScript; return; }
      // 标记需要从 URL 获取（在 update 外部处理 fetch）
    });
    if (rawScript) return rawScript;

    // 需要从 URL 下载
    const data = await this.getData();
    const s = data.scripts.find(s => s.id === id);
    if (!s || !s.scriptUrl) return null;
    try {
      const resp = await fetch(s.scriptUrl);
      if (resp.ok) {
        const content = await resp.text();
        await this.store.update(d => {
          const script = d.scripts.find(sc => sc.id === id);
          if (script) {
            script.rawScript = content;
            script.updatedAt = Date.now();
          }
        });
        return content;
      }
    } catch (e) { console.error('[Storage] Failed to fetch script from URL:', e); }
    return null;
  }

  async setDefaultScript(id: string): Promise<void> {
    await this.store.update(data => {
      if (!data.scripts.find(s => s.id === id)) throw new Error('脚本不存在');
      data.default_source_id = id;
    });
  }

  async getDefaultScript(): Promise<{ id: string; name: string } | null> {
    const data = await this.getData();
    if (!data.default_source_id) return null;
    const s = data.scripts.find(s => s.id === data.default_source_id);
    if (!s) return null;
    return { id: s.id, name: s.name };
  }

  async deleteScript(id: string): Promise<void> {
    await this.store.update(data => {
      if (!data.scripts.find(s => s.id === id)) throw new Error('脚本不存在');
      data.scripts = data.scripts.filter(s => s.id !== id);
      delete data.script_stats[id];
      delete data.circuit_breakers[id];
      if (data.default_source_id === id) {
        data.default_source_id = data.scripts[0]?.id || null;
      }
    });
  }

  async getScriptStats(): Promise<ScriptStatsData> {
    const data = await this.getData();
    const result: ScriptStatsData = {};
    for (const [id, entry] of Object.entries(data.script_stats)) {
      result[id] = entry.script;
    }
    return result;
  }

  async updateScriptStats(scriptId: string, success: boolean, responseTime: number = 0): Promise<void> {
    await this.store.update(data => {
      const entry = data.script_stats[scriptId] || {
        script: { success: 0, fail: 0, lastSuccessAt: 0, lastFailAt: 0, avgResponseTime: 0, totalRequests: 0 },
        sources: {},
      };
      const stats = entry.script;
      const newTotal = stats.totalRequests + 1;
      const newSuccess = stats.success + (success ? 1 : 0);
      const newFail = stats.fail + (success ? 0 : 1);
      const newAvg = success && responseTime > 0 ? (stats.avgResponseTime * (newSuccess - 1) + responseTime) / newSuccess : stats.avgResponseTime;
      entry.script = {
        success: newSuccess, fail: newFail,
        lastSuccessAt: success ? Date.now() : stats.lastSuccessAt,
        lastFailAt: success ? stats.lastFailAt : Date.now(),
        avgResponseTime: newAvg, totalRequests: newTotal,
      };
      data.script_stats[scriptId] = entry;
    });
  }

  getScriptSuccessRate(stats: ScriptStats): number {
    const total = stats.success + stats.fail;
    if (total < MIN_SAMPLES) return 0.5;
    return stats.success / total;
  }

  async getSourceStats(): Promise<ScriptSourceStats> {
    const data = await this.getData();
    const result: ScriptSourceStats = {};
    for (const [id, entry] of Object.entries(data.script_stats)) {
      result[id] = entry.sources;
    }
    return result;
  }

  async updateSourceStats(scriptId: string, source: string, success: boolean): Promise<void> {
    await this.store.update(data => {
      const entry = data.script_stats[scriptId] || {
        script: { success: 0, fail: 0, lastSuccessAt: 0, lastFailAt: 0, avgResponseTime: 0, totalRequests: 0 },
        sources: {},
      };
      const s = entry.sources[source] || { success: 0, fail: 0 };
      entry.sources[source] = {
        success: s.success + (success ? 1 : 0),
        fail: s.fail + (success ? 0 : 1),
      };
      data.script_stats[scriptId] = entry;
    });
  }

  private getSuccessRate(stats: SourceStats): number {
    const total = stats.success + stats.fail;
    if (total < MIN_SAMPLES) return -1;
    return stats.success / total;
  }

  async getSortedSourcesBySuccessRate(scriptId: string, excludeSources: string[] = []): Promise<string[]> {
    const data = await this.getData();
    const entry = data.script_stats[scriptId];
    const stats = entry?.sources || {};
    const sources = [...ALL_SOURCES].filter(s => !excludeSources.includes(s));
    if (Math.random() < EPSILON) {
      for (let i = sources.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [sources[i], sources[j]] = [sources[j], sources[i]];
      }
      return sources;
    }
    return sources.sort((a, b) => {
      const rateA = this.getSuccessRate(stats[a] || { success: 0, fail: 0 });
      const rateB = this.getSuccessRate(stats[b] || { success: 0, fail: 0 });
      if (rateA === -1 && rateB === -1) return Math.random() - 0.5;
      if (rateA === -1) return 1; if (rateB === -1) return -1;
      if (Math.abs(rateA - rateB) < 0.01) return Math.random() - 0.5;
      return rateB - rateA;
    });
  }

  async getSortedScriptsBySuccessRate(scriptIds: string[], defaultScriptId: string | null): Promise<string[]> {
    const data = await this.getData();
    const stats = data.script_stats;
    return [...scriptIds].sort((a, b) => {
      if (a === defaultScriptId) return -1; if (b === defaultScriptId) return 1;
      const statsA = stats[a]?.script;
      const statsB = stats[b]?.script;
      const rateA = statsA ? this.getScriptSuccessRate(statsA) : 0.5;
      const rateB = statsB ? this.getScriptSuccessRate(statsB) : 0.5;
      return rateB - rateA;
    });
  }

  async isScriptCircuitBreakerTripped(scriptId: string): Promise<boolean> {
    let tripped = false;
    await this.store.update(data => {
      const cb = data.circuit_breakers[scriptId];
      if (!cb || !cb.isTripped) return;
      if (Date.now() >= cb.resetAt) {
        // 冷却到期 -> 半开: 放行探测请求, 但保留 tripCount 用于判断半开状态
        cb.isTripped = false;
        cb.consecutiveFails = 0;
      } else {
        tripped = true;
      }
    });
    return tripped;
  }

  async recordScriptFailure(scriptId: string): Promise<boolean> {
    let tripped = false;
    await this.store.update(data => {
      if (!data.circuit_breakers[scriptId]) {
        data.circuit_breakers[scriptId] = { isTripped: false, tripCount: 0, lastTripAt: 0, resetAt: 0, consecutiveFails: 0 };
      }
      const cb = data.circuit_breakers[scriptId];
      cb.consecutiveFails++;

      // 半开探测失败: tripCount>0 说明熔断过, consecutiveFails===1 说明刚恢复就失败 -> 重新熔断, 冷却升级
      if (!cb.isTripped && cb.tripCount > 0 && cb.consecutiveFails === 1) {
        cb.isTripped = true;
        cb.tripCount++;
        cb.lastTripAt = Date.now();
        cb.resetAt = Date.now() + getCooldownMs(cb.tripCount);
        tripped = true;
        return;
      }

      // 正常连续失败达阈值 -> 熔断
      if (cb.consecutiveFails >= CIRCUIT_BREAKER_THRESHOLD && !cb.isTripped) {
        cb.isTripped = true;
        cb.tripCount++;
        cb.lastTripAt = Date.now();
        cb.resetAt = Date.now() + getCooldownMs(cb.tripCount);
        tripped = true;
      }
    });
    return tripped;
  }

  async recordScriptSuccess(scriptId: string): Promise<void> {
    await this.store.update(data => {
      const cb = data.circuit_breakers[scriptId];
      if (!cb) return;
      // 半开探测成功 (tripCount>0 && !isTripped) 或降级路径中熔断脚本成功 -> 完全恢复, 重置冷却级别
      if (cb.tripCount > 0 || cb.isTripped) {
        cb.isTripped = false;
        cb.consecutiveFails = 0;
        cb.tripCount = 0;
      }
    });
  }

  async getActiveScriptIds(): Promise<string[]> {
    const data = await this.getData();
    return data.scripts.map(s => s.id);
  }

  private parseScriptInfo(script: string): ScriptInfo & { id: string } {
    const commentMatch = /^\/\*[\s\S]+?\*\//.exec(script);
    if (!commentMatch) throw new Error("无效的自定义源文件：缺少注释头部");
    const commentBlock = commentMatch[0];
    const info = this.parseCommentBlock(commentBlock);
    const supportedSources = this.parseSupportedSources(script);
    return { id: `user_api_${Math.random().toString(36).substring(2, 8)}_${Date.now()}`, name: info.name || 'unknown', description: info.description || '', author: info.author || '', homepage: info.homepage || '', version: info.version || '', supportedSources, isDefault: false, createdAt: 0, updatedAt: 0 } as ScriptInfo & { id: string };
  }

  private parseCommentBlock(commentBlock: string): Record<string, string> {
    const INFO_NAMES: Record<string, number> = { name: 24, description: 36, author: 56, homepage: 1024, version: 36 };
    const infoArr = commentBlock.split(/\r?\n/);
    const rxp = /^\s?\*\s?@(\w+)\s(.+)$/;
    const infos: Record<string, string> = {};
    for (const info of infoArr) { const result = rxp.exec(info); if (!result) continue; const key = result[1] as keyof typeof INFO_NAMES; if (INFO_NAMES[key] == null) continue; infos[key] = result[2].trim(); }
    for (const [key, len] of Object.entries(INFO_NAMES)) { infos[key] ||= ''; if (infos[key] && infos[key].length > len) infos[key] = infos[key].substring(0, len); }
    return infos;
  }

  private parseSupportedSources(script: string): string[] {
    const sources: string[] = [];
    const ALL_POSSIBLE = ['kw', 'kg', 'tx', 'wy', 'mg'];
    const patterns = [
      /['"]?(kw|kg|tx|wy|mg)['"]?\s*:/g,
      /source[s]?\s*[:=]\s*\[([^\]]+)\]/g,
      /MUSIC_SOURCE\s*[=:]\s*Object\.keys\s*\(\s*MUSIC_QUALITY\s*\)/g,
      /MUSIC_QUALITY\s*[=\{]/g,
    ];
    for (const pattern of patterns) {
      const matches = script.matchAll(pattern);
      for (const match of matches) {
        if (match[1]) {
          const sourceList = match[1].match(/['"]?(kw|kg|tx|wy|mg)['"]?/g);
          if (sourceList) { for (const s of sourceList) { const clean = s.replace(/['"]/g, '').trim(); if (!sources.includes(clean)) sources.push(clean); } }
        } else {
          for (const src of ALL_POSSIBLE) { if (match[0].includes(src) && !sources.includes(src)) sources.push(src); }
        }
      }
    }
    if (sources.length === 0) {
      for (const src of ALL_POSSIBLE) {
        const regex = new RegExp(`['"]${src}['"]|\\b${src}\\b\\s*:`, 'gi');
        if (regex.test(script)) { sources.push(src); }
      }
      if (sources.length === 0) {
        for (const src of ALL_POSSIBLE) {
          const obfuscatedPatterns = [
            new RegExp(`[|&'\\"]${src}[|&'\\"]`, 'g'),
            new RegExp(`[|&'\\"]${src}`, 'g'),
            new RegExp(`${src}[|&'\\"]`, 'g'),
            new RegExp(`\\d*${src}\\b`, 'g'),
            new RegExp(`\\b${src}\\d*`, 'g'),
          ];
          for (const pat of obfuscatedPatterns) { if (pat.test(script)) { if (!sources.includes(src)) sources.push(src); break; } }
        }
      }
      if (sources.length === 0 && script.includes('@name')) { return [...ALL_POSSIBLE]; }
      if (sources.length === 0 && (script.includes('jsjiami') || script.includes('聚合') || script.includes('MUSIC_SOURCE') || script.includes('musicUrl'))) { return [...ALL_POSSIBLE]; }
    }
    return sources.length > 0 ? sources : ['unknown'];
  }
}
