// ==================== 统一 AppData 存储（方案 C+D） ====================
// 所有读写 app_data 的入口都经过 AppDataStore，串行化写入避免竞态，JSON 损坏时拒绝覆盖。
//
// 合并说明：
//   scriptStats + sourceStats  → script_stats: { [id]: { script: ScriptStats, sources: { [source]: SourceStats } } }
//   share_usage + share_usage_total + api_calls + api_calls_total → usage: { daily, share_total, api_total }

// ==================== 类型定义 ====================

export interface ScriptInfo {
  id: string;
  name: string;
  description: string;
  author: string;
  homepage: string;
  version: string;
  supportedSources: string[];
  scriptUrl?: string;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
  rawScript?: string;
}

export interface ScriptStats {
  success: number;
  fail: number;
  lastSuccessAt: number;
  lastFailAt: number;
  avgResponseTime: number;
  totalRequests: number;
}

export interface SourceStats {
  success: number;
  fail: number;
}

export interface CircuitBreakerState {
  isTripped: boolean;
  tripCount: number;
  lastTripAt: number;
  resetAt: number;
  consecutiveFails: number;
}

export interface ShareConfig {
  status: number; // 0=未开启, 1=开启, 2=被踢下线
  node_id: string;
  daily_limit: number;
  reserved_limit: number;
  contributor_name: string;
  shared_since: number;
}

// 合并后的脚本统计条目
export interface ScriptStatsEntry {
  script: ScriptStats;
  sources: Record<string, SourceStats>;
}

// 合并后的用量统计
export interface UsageStats {
  daily: Record<string, { share: number; api: number }>;
  share_total: number;
  api_total: number;
}

// 统一 AppData
export interface AppData {
  share_config: ShareConfig;
  usage: UsageStats;
  scripts: ScriptInfo[];
  script_stats: Record<string, ScriptStatsEntry>;
  circuit_breakers: Record<string, CircuitBreakerState>;
  default_source_id: string | null;
}

// ==================== 默认值 ====================

export const DEFAULT_SHARE_CONFIG: ShareConfig = {
  status: 0, node_id: "", daily_limit: 50000, reserved_limit: 20000, contributor_name: "", shared_since: 0,
};

export function defaultAppData(): AppData {
  return {
    share_config: { ...DEFAULT_SHARE_CONFIG },
    usage: { daily: {}, share_total: 0, api_total: 0 },
    scripts: [],
    script_stats: {},
    circuit_breakers: {},
    default_source_id: null,
  };
}

// ==================== 数据迁移 ====================

export function migrateAppData(raw: any): AppData {
  const data = defaultAppData();

  // share_config（含旧版 enabled → status 迁移）
  if (raw.share_config) {
    const sc = { ...raw.share_config };
    if (sc.enabled !== undefined && sc.status === undefined) {
      sc.status = sc.enabled ? 1 : 0;
      delete sc.enabled;
    }
    data.share_config = { ...DEFAULT_SHARE_CONFIG, ...sc };
  }

  // usage（合并 share_usage + share_usage_total + api_calls + api_calls_total）
  if (raw.usage && typeof raw.usage === 'object' && !Array.isArray(raw.usage)) {
    // 新格式
    data.usage = raw.usage;
    if (!data.usage.daily) data.usage.daily = {};
    if (typeof data.usage.share_total !== 'number') data.usage.share_total = 0;
    if (typeof data.usage.api_total !== 'number') data.usage.api_total = 0;
  } else {
    // 旧格式迁移
    const shareUsage = raw.share_usage || {};
    const apiCalls = raw.api_calls || {};
    const allDates = new Set([...Object.keys(shareUsage), ...Object.keys(apiCalls)]);
    for (const date of allDates) {
      data.usage.daily[date] = { share: shareUsage[date] || 0, api: apiCalls[date] || 0 };
    }
    data.usage.share_total = raw.share_usage_total || 0;
    data.usage.api_total = raw.api_calls_total || 0;
    // 兜底：如果 total 为 0 但有 daily 数据，从 daily 求和
    if (data.usage.share_total === 0) {
      data.usage.share_total = Object.values(shareUsage).reduce((a: number, b: any) => a + (Number(b) || 0), 0);
    }
    if (data.usage.api_total === 0) {
      data.usage.api_total = Object.values(apiCalls).reduce((a: number, b: any) => a + (Number(b) || 0), 0);
    }
  }

  // scripts
  if (Array.isArray(raw.scripts)) data.scripts = raw.scripts;

  // script_stats（合并 scriptStats + sourceStats）
  if (raw.script_stats && typeof raw.script_stats === 'object' && !Array.isArray(raw.script_stats)) {
    // 新格式
    data.script_stats = raw.script_stats;
  } else {
    // 旧格式迁移
    const scriptStats = raw.scriptStats || {};
    const sourceStats = raw.sourceStats || {};
    const scriptIds = new Set([...Object.keys(scriptStats), ...Object.keys(sourceStats)]);
    for (const id of scriptIds) {
      data.script_stats[id] = {
        script: scriptStats[id] || { success: 0, fail: 0, lastSuccessAt: 0, lastFailAt: 0, avgResponseTime: 0, totalRequests: 0 },
        sources: sourceStats[id] || {},
      };
    }
  }

  // circuit_breakers（兼容旧驼峰命名）
  data.circuit_breakers = raw.circuit_breakers || raw.circuitBreakers || {};

  // default_source_id（兼容旧驼峰命名）
  if (raw.default_source_id !== undefined) {
    data.default_source_id = raw.default_source_id;
  } else if (raw.defaultSourceId !== undefined) {
    data.default_source_id = raw.defaultSourceId;
  }

  return data;
}

// ==================== AppDataStore（方案 C+D 核心） ====================

const STORAGE_KEY = 'app_data';

export class AppDataStore {
  private db: D1Database;
  private _cache: AppData | null = null;
  private _writeQueue: Promise<void> = Promise.resolve();
  private _corrupted = false;

  constructor(db: D1Database) {
    this.db = db;
  }

  private async ensureTable(): Promise<void> {
    let lastErr: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.db.prepare("CREATE TABLE IF NOT EXISTS storage (key TEXT PRIMARY KEY, value TEXT)").run();
        return;
      } catch (e: any) {
        lastErr = e;
        console.error(`[AppDataStore] ensureTable error (attempt ${attempt + 1}/3):`, e.message);
        if (attempt < 2) await new Promise(r => setTimeout(r, 100));
      }
    }
    throw lastErr;
  }

  /**
   * 读取 AppData（带缓存）。
   * 如果 JSON 解析失败，设置 _corrupted 标志并抛出异常（方案 D：拒绝用默认值覆盖损坏数据）。
   * 非 JSON 错误（D1 连接等）不设置 _corrupted，允许后续重试。
   */
  async get(): Promise<AppData> {
    if (this._cache) return this._cache;
    if (this._corrupted) throw new Error("app_data corrupted, refusing to read");

    // 先确保表存在（独立 try-catch，不触发 corruption）
    try {
      await this.ensureTable();
    } catch (e: any) {
      console.error("[AppDataStore] ensureTable error:", e.message);
      throw e;
    }

    // 读取数据（带重试，D1 偶发错误时自动重试）
    let row: { value: string } | null = null;
    let lastErr: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        row = await this.db.prepare("SELECT value FROM storage WHERE key=?").bind(STORAGE_KEY).first<{ value: string }>();
        lastErr = null;
        break;
      } catch (e: any) {
        lastErr = e;
        console.error(`[AppDataStore] DB query error (attempt ${attempt + 1}/3):`, e.message);
        if (attempt < 2) await new Promise(r => setTimeout(r, 100));
      }
    }
    if (lastErr) throw lastErr;

    if (row) {
      // 有数据 → 尝试 JSON 解析
      try {
        const parsed = JSON.parse(row.value);
        this._cache = migrateAppData(parsed);
        return this._cache;
      } catch (e: any) {
        // 方案 D：仅 JSON 损坏时设置 _corrupted，阻止后续写入覆盖
        this._corrupted = true;
        console.error("[AppDataStore] JSON corruption detected, refusing to overwrite:", e.message);
        throw new Error("app_data corrupted: " + e.message);
      }
    }
    // DB 中无记录 → 首次使用，返回默认值
    this._cache = defaultAppData();
    return this._cache;
  }

  /**
   * 串行化更新（方案 C：所有写入通过队列排队，避免竞态）。
   * updater 回调内修改 data 对象，save 由本方法负责。
   */
  async update(updater: (data: AppData) => void): Promise<void> {
    let updateError: any = null;
    this._writeQueue = this._writeQueue.then(async () => {
      // 强制刷新缓存，确保读到 DB 最新值
      this._cache = null;
      const data = await this.get();
      updater(data);
      await this._save(data);
    }).catch(err => {
      // 队列中的错误不应阻塞后续操作，但需要传递给调用者
      console.error("[AppDataStore] update error:", err.message);
      updateError = err;
    });
    await this._writeQueue;
    if (updateError) throw updateError;
  }

  /**
   * 批量更新（一次 DB 读写应用多个修改，减少 DB 调用）。
   */
  async batchUpdate(updaters: Array<(data: AppData) => void>): Promise<void> {
    await this.update(data => {
      for (const fn of updaters) fn(data);
    });
  }

  private async _save(data: AppData): Promise<void> {
    if (this._corrupted) {
      console.warn("[AppDataStore] Skipping save due to corruption flag");
      return;
    }
    try {
      await this.ensureTable();
      await this.db.prepare("INSERT OR REPLACE INTO storage (key,value) VALUES (?,?)").bind(STORAGE_KEY, JSON.stringify(data)).run();
      this._cache = data;
    } catch (e: any) {
      console.error("[AppDataStore] save error:", e.message);
    }
  }

  /** 外部直接保存（兼容 ScriptStorage.flush 模式） */
  async save(data: AppData): Promise<void> {
    await this.update(_ => { /* no-op, data already modified in-place */ });
    // 直接保存传入的 data
    this._writeQueue = this._writeQueue.then(async () => {
      await this._save(data);
    }).catch(err => console.error("[AppDataStore] save error:", err.message));
    await this._writeQueue;
  }

  /** 清除缓存（每个请求开始时调用，确保读到最新 DB 数据） */
  invalidateCache(): void {
    this._cache = null;
  }

  /** 检查是否已损坏 */
  isCorrupted(): boolean {
    return this._corrupted;
  }

  /** 重置损坏标志（管理员手动修复后调用） */
  clearCorruption(): void {
    this._corrupted = false;
    this._cache = null;
  }
}

// ==================== 工具函数 ====================

export function getTodayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

export function getCutoffDateString(): string {
  return new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 清理 7 天前的用量数据 */
export function cleanupUsageDaily(data: AppData): void {
  const cutoff = getCutoffDateString();
  for (const key of Object.keys(data.usage.daily)) {
    if (key < cutoff) delete data.usage.daily[key];
  }
}
