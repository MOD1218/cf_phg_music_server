import { ScriptStorage } from './storage.ts';
import { ScriptRunner } from './script_runner.ts';
import { SearchService } from './services/search_service.ts';
import { ShortLinkService } from './services/shortlink_service.ts';
import { SongListService } from './services/songlist_service.ts';
import { LyricService } from './services/lyric_service.ts';
import { AIRecommendService } from './services/ai_recommend_service.ts';
import { AppDataStore, type AppData, type ShareConfig, getTodayDateString, cleanupUsageDaily, defaultAppData } from './app_data.ts';
import pkg from '../package.json';

export interface Env {
  DB: D1Database;
  API_KEY?: string;       // 主密钥（兼作 Owner Key）
  PUBLIC_KEY?: string;     // 公开密钥（独立配置，32位hex，可修改）
  AI_MODEL?: string;
  AI: any;
}

const REQUEST_TIMEOUT_MS = 30000;

// ==================== 版本信息（来自 package.json） ====================
const SERVER_VERSION = pkg.version;             // "1.0.10"
const SERVER_VERSION_CODE = (pkg as any).versionCode || 10010;  // 10010
const SERVER_PLATFORM = 'cloudflare';
// 本服务端要求的最低客户端版本
const MIN_CLIENT_VERSION = '1.0.01';
const MIN_CLIENT_VERSION_CODE = 1001;

// ========== ScriptRunner 缓存（CF Workers Isolate 级别） ==========
// CF Workers 在同一 Isolate 内复用模块级变量。
// 缓存已初始化的 ScriptRunner 实例，避免每次请求都重新加载 QuickJS + 执行脚本。
// 参考: https://architectingoncloudflare.com/chapter-03/
// "Expensive initialisation producing immutable results belongs in global scope"

interface CachedRunner {
  runner: ScriptRunner;
  scriptId: string;
  rawScriptHash: string;
  createdAt: number;
  lastUsedAt: number;
}

const _runnerCache = new Map<string, CachedRunner>();
const CACHE_MAX_AGE_MS = 10 * 60 * 1000;
const CACHE_MAX_SIZE = 5;

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
  return 'h' + Math.abs(h).toString(36);
}

async function getOrCreateRunner(scriptInfo: { id: string; name: string; rawScript: string }): Promise<ScriptRunner> {
  const hash = simpleHash(scriptInfo.rawScript);
  const cacheKey = `${scriptInfo.id}:${hash}`;

  const cached = _runnerCache.get(cacheKey);
  if (cached && cached.runner.isReady()) {
    cached.lastUsedAt = Date.now();
    console.log(`[RunnerCache] ✅ HIT ${scriptInfo.name} (age=${Math.round((Date.now() - cached.createdAt) / 1000)}s, key=${cacheKey.substring(0, 30)}...)`);
    return cached.runner;
  }

  console.log(`[RunnerCache] MISS ${scriptInfo.name}, creating new instance...`);
  const runner = new ScriptRunner(scriptInfo);
  await runner.initialize();

  _runnerCache.set(cacheKey, {
    runner,
    scriptId: scriptInfo.id,
    rawScriptHash: hash,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  });

  // 清理过期/超量的缓存
  if (_runnerCache.size > CACHE_MAX_SIZE) {
    const now = Date.now();
    for (const [key, entry] of _runnerCache) {
      if (now - entry.lastUsedAt > CACHE_MAX_AGE_MS || _runnerCache.size > CACHE_MAX_SIZE) {
        try { entry.runner.dispose(); } catch (_e) {}
        _runnerCache.delete(key);
        console.log(`[RunnerCache] 🗑️ Evicted ${key.substring(0, 30)}...`);
      }
    }
  }

  return runner;
}

function jsonResponse(data: any, status = 200, msg = 'success', extra?: any): Response {
  const body: any = { code: status === 200 ? 200 : status, msg, data };
  if (extra) Object.assign(body, extra);
  return Response.json(body, { status });
}

const searchService = new SearchService();
const shortLinkService = new ShortLinkService();
const songListService = new SongListService();
const lyricService = new LyricService();

// POST /api/ai/chat - AI 对话接口
async function handleAIChat(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as any;
    
    if (!body.messages || !Array.isArray(body.messages)) {
      return jsonResponse(null, 400, '缺少 messages 参数（数组格式）');
    }

    if (body.messages.length === 0) {
      return jsonResponse(null, 400, 'messages 不能为空');
    }

    const aiService = new AIRecommendService(env.AI);
    const result = await aiService.chat({
      messages: body.messages,
      model: body.model,
      max_tokens: body.max_tokens,
      temperature: body.temperature,
    }, env.AI_MODEL || '');

    return jsonResponse(result);
  } catch (error: any) {
    console.error('[AI Chat] Error:', error.message);
    return jsonResponse(null, 500, error.message || 'AI 服务调用失败');
  }
}

// GET /api/ai/models - 获取可用模型列表
async function handleGetAIModels(): Promise<Response> {
  const aiService = new AIRecommendService(null);
  return jsonResponse({
    models: aiService.getAvailableModels(),
    currentModel: '可通过环境变量 AI_MODEL 或请求参数 model 动态切换',
  });
}

async function handleImportScriptFromUrl(request: Request, storage: ScriptStorage): Promise<Response> {
  const body = await request.json() as { url: string };
  if (!body.url) return jsonResponse(null, 400, '缺少 url 参数');
  try {
    const info = await storage.importScriptFromUrl(body.url);
    const loadedScripts = await storage.getScripts();
    const stats = await storage.getScriptStats();
    const defaultInfo = await storage.getDefaultScript();
    const scriptsFormatted = await Promise.all(loadedScripts.map(async (s) => {
      const ss = stats[s.id];
      const sr = ss ? storage.getScriptSuccessRate(ss) : 0;
      const tr = ss ? ss.success + ss.fail : 0;
      const icb = await storage.isScriptCircuitBreakerTripped(s.id);
      return { id: s.id, name: s.name, description: s.description, author: s.author, homepage: s.homepage, version: s.version, createdAt: new Date(s.createdAt).toISOString(), supportedSources: (s.supportedSources.length === 1 && s.supportedSources[0] === 'unknown') ? ['kw', 'kg', 'tx', 'wy', 'mg'] : s.supportedSources, isDefault: s.isDefault, successRate: tr > 0 ? sr : null, successCount: ss?.success || 0, failCount: ss?.fail || 0, totalRequests: tr, isCircuitBroken: icb };
    }));
    return jsonResponse({
      success: true,
      defaultSource: defaultInfo ? { id: defaultInfo.id, name: defaultInfo.name, supportedSources: (await storage.getScript(defaultInfo.id))?.supportedSources || [] } : null,
      scripts: scriptsFormatted,
    }, 200, '从URL导入成功');
  } catch (e: any) { return jsonResponse(null, 500, e.message || '导入失败'); }
}

async function handleImportScriptRaw(request: Request, storage: ScriptStorage): Promise<Response> {
  const body = await request.json() as { name: string; content: string; url?: string };
  if (!body.content || !body.name) return jsonResponse(null, 400, '缺少 name 或 content 参数');
  try { const info = await storage.importScriptRaw(body.name, body.content, body.url || ''); return jsonResponse(info); }
  catch (e: any) { return jsonResponse(null, 500, e.message || '导入失败'); }
}

// GET /api/scripts/loaded - 获取已加载脚本列表(含统计)
async function handleGetLoadedScripts(request: Request, storage: ScriptStorage): Promise<Response> {
  try {
    const scripts = await storage.getScripts();
    const stats = await storage.getScriptStats();
    const result = await Promise.all(scripts.map(async (s) => {
      const scriptStats = stats[s.id];
      const successRate = scriptStats ? storage.getScriptSuccessRate(scriptStats) : 0;
      const totalRequests = scriptStats ? scriptStats.success + scriptStats.fail : 0;
      const isCircuitBroken = await storage.isScriptCircuitBreakerTripped(s.id);
      return {
        id: s.id, name: s.name, description: s.description, author: s.author,
        homepage: s.homepage, version: s.version, createdAt: new Date(s.createdAt).toISOString(),
        supportedSources: s.supportedSources, isDefault: s.isDefault,
        successRate: totalRequests > 0 ? successRate : null,
        successCount: scriptStats?.success || 0,
        failCount: scriptStats?.fail || 0,
        totalRequests,
        isCircuitBroken,
      };
    }));
    return jsonResponse(result);
  } catch (e: any) { return jsonResponse(null, 500, e.message); }
}

// POST /api/scripts/default - 设置默认脚本
async function handleSetDefaultScript(request: Request, storage: ScriptStorage): Promise<Response> {
  const body = await request.json() as { id: string };
  if (!body.id) return jsonResponse(null, 400, '缺少 id 参数');
  try {
    await storage.setDefaultScript(body.id);
    return jsonResponse({ success: true });
  }
  catch (e: any) { return jsonResponse(null, 500, e.message); }
}

// GET /api/scripts/default - 获取默认脚本信息
async function handleGetDefaultScript(storage: ScriptStorage): Promise<Response> {
  try {
    const def = await storage.getDefaultScript();
    if (!def) return jsonResponse(null, 404, '未设置默认脚本');
    return jsonResponse({ id: def.id, name: def.name });
  } catch (e: any) { return jsonResponse(null, 500, e.message); }
}

// POST /api/scripts/delete - 删除脚本
async function handleDeleteScript(request: Request, storage: ScriptStorage): Promise<Response> {
  const body = await request.json() as { id: string };
  if (!body.id) return jsonResponse(null, 400, '缺少 id 参数');
  try {
    await storage.deleteScript(body.id);
    const loadedScripts = await storage.getScripts();
    const stats = await storage.getScriptStats();
    const defaultInfo = await storage.getDefaultScript();
    const scriptsFormatted = await Promise.all(loadedScripts.map(async (s) => {
      const ss = stats[s.id];
      const sr = ss ? storage.getScriptSuccessRate(ss) : 0;
      const tr = ss ? ss.success + ss.fail : 0;
      const icb = await storage.isScriptCircuitBreakerTripped(s.id);
      return { id: s.id, name: s.name, description: s.description, author: s.author, homepage: s.homepage, version: s.version, createdAt: new Date(s.createdAt).toISOString(), supportedSources: s.supportedSources, isDefault: s.isDefault, successRate: tr > 0 ? sr : null, successCount: ss?.success || 0, failCount: ss?.fail || 0, totalRequests: tr, isCircuitBroken: icb };
    }));
    return jsonResponse({
      success: true,
      defaultSource: defaultInfo ? { id: defaultInfo.id, name: defaultInfo.name, supportedSources: (await storage.getScript(defaultInfo.id))?.supportedSources || [] } : null,
      scripts: scriptsFormatted,
    }, 200, '脚本已删除');
  } catch (e: any) { return jsonResponse(null, 500, e.message); }
}

// POST /api/music/lyric - 获取歌词
async function handleGetLyric(request: Request): Promise<Response> {
  try {
    const body = await request.json() as any;
    if (!body.source) return jsonResponse(null, 400, '缺少必要参数: source');
    if (!body.songId) return jsonResponse(null, 400, '缺少必要参数: songId');
    const musicInfo: any = { source: body.source };
    switch (body.source) {
      case 'kw': musicInfo.songmid = body.songId; break;
      case 'kg': musicInfo.hash = body.songId; musicInfo.name = body.name || '未知歌曲'; break;
      case 'tx': musicInfo.songId = body.songId; break;
      case 'wy': musicInfo.songId = body.songId; break;
      case 'mg': musicInfo.copyrightId = body.songId; musicInfo.name = body.name; musicInfo.singer = body.singer; break;
      default: return jsonResponse(null, 400, `不支持的音源: ${body.source}`);
    }
    const result = await lyricService.getLyric(musicInfo);
    return jsonResponse({ lyric: result.lyric, tlyric: result.tlyric, rlyric: result.rlyric, lxlyric: result.lxlyric }, 200, '获取歌词成功');
  } catch (e: any) { return jsonResponse(null, 500, e.message || '获取歌词失败'); }
}

// GET /api/search - 歌曲搜索
async function handleSearch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const keyword = url.searchParams.get('keyword') || url.searchParams.get('key') || '';
  const source = url.searchParams.get('source') || '';
  const page = parseInt(url.searchParams.get('page') || '1');
  const limit = parseInt(url.searchParams.get('limit') || '20');

  if (!keyword) return jsonResponse(null, 400, '缺少 keyword 参数');
  try {
    const results = await searchService.search(keyword, source || undefined, page, limit);
    return jsonResponse(results);
  } catch (e: any) { return jsonResponse(null, 500, e.message); }
}

// POST /api/songlist/detail - 获取歌单详情
async function handleGetSongListDetail(request: Request): Promise<Response> {
  const body = await request.json() as { source: string; id: string };
  if (!body.source || !body.id) return jsonResponse(null, 400, '缺少 source 或 id 参数');
  
  try {
    const result = await songListService.getListDetail(body.source, body.id);
    return jsonResponse(result);
  } catch (e: any) { return jsonResponse(null, 500, e.message); }
}

// POST /api/songlist/detail/by-link - 通过链接获取歌单详情
async function handleGetSongListDetailByLink(request: Request): Promise<Response> {
  const body = await request.json() as { link: string; source?: string };
  if (!body.link) return jsonResponse(null, 400, '缺少 link 参数');
  
  try {
    const parsed = await shortLinkService.parseShortLink(body.link);
    if (!parsed || !parsed.id) return jsonResponse(null, 500, '短链接解析结果无效');
    const result = await songListService.getListDetail(parsed.source, parsed.id);
    return jsonResponse(result);
  } catch (e: any) { return jsonResponse(null, 500, e.message || '解析链接失败'); }
}

// POST /api/music/url - 核心接口，支持换脚本和换源（含熔断/统计/重试/换源）
// 总超时固定 15000ms，根据可用脚本数量分配
// 1脚本=15000ms, 2脚本=7300ms, 3+脚本=4300ms
function calculateScriptTimeouts(scriptIds: string[], realAvailableCount: number): Map<string, number> {
  const timeouts = new Map<string, number>();
  if (realAvailableCount === 0 || scriptIds.length === 0) return timeouts;
  const perScript = realAvailableCount === 1 ? 15000 : realAvailableCount === 2 ? 7300 : 4300;
  for (const id of scriptIds) timeouts.set(id, perScript);
  console.log(`[API] 动态超时: 脚本数=${realAvailableCount}, 每脚本=${perScript}ms`);
  return timeouts;
}

// POST /api/music/url - 核心接口，支持换脚本和换源（含熔断/统计/重试/换源）
async function handleGetMusicUrl(request: Request, storage: ScriptStorage, env?: Env): Promise<Response> {
  let scriptId = 'unknown';
  let scriptName = 'unknown';

  try {
    const body = await request.json() as any;
    if (!body.source || !body.quality) return jsonResponse(null, 400, '缺少必要参数: source, quality');

    const allowToggleSource = body.allowToggleSource !== false;
    const excludeSources = body.excludeSources || [];
    const songId = body.songmid || body.id || body.songId || body.musicInfo?.id || body.musicInfo?.songmid || body.musicInfo?.hash || '';
    const name = body.name || body.musicInfo?.name || '未知歌曲';
    const singer = body.singer || body.musicInfo?.singer || '未知歌手';
    const originalSource = body.source;

    // 步骤1：获取可用脚本（按成功率排序，跳过已熔断的）
    const allScripts = await storage.getScripts();
    let availableScriptIds: string[] = [];
    const trippedScriptIds: string[] = [];

    for (const s of allScripts) {
      if (s.supportedSources.includes(originalSource)) {
        const isTripped = await storage.isScriptCircuitBreakerTripped(s.id);
        if (isTripped) { trippedScriptIds.push(s.id); console.log(`[API] ⚠️ 脚本 ${s.name} 已熔断但仍支持 ${originalSource}`); }
        else availableScriptIds.push(s.id);
      }
    }

    // 如果正常脚本为空，降级使用熔断脚本或立即换源
    if (availableScriptIds.length === 0) {
      // 特殊情况：服务器上一个脚本都没导入，返回特定错误码让客户端引导导入
      if (allScripts.length === 0) {
        return jsonResponse(null, 410, '尚未导入任何音源脚本，请先导入音源脚本');
      }
      if (trippedScriptIds.length > 0) {
        availableScriptIds = [...trippedScriptIds];
        console.log(`[API] 所有支持${originalSource}的脚本均已熔断(${trippedScriptIds.length}个)，降级使用`);
      } else if (allowToggleSource && originalSource !== 'local') {
        console.log(`[API] 无脚本支持 ${originalSource}，立即换源, allScripts=${allScripts.length}, allSources=${allScripts.map(s => s.supportedSources.join(',')).join(';')}`);
        return await handleForceToggle(body, songId, name, singer, originalSource, excludeSources, storage);
      } else {
        return jsonResponse(null, 411, `没有支持 ${originalSource} 源的脚本`);
      }
    }

    // 按成功率排序
    const sortedIds = await storage.getSortedScriptsBySuccessRate(availableScriptIds, (await storage.getDefaultScript())?.id ?? null);
    const scriptTimeouts = calculateScriptTimeouts(sortedIds, sortedIds.length);

    const triedScripts: { scriptId: string; scriptName: string; message: string; responseTime: number; diagnostics?: any }[] = [];
    let lastResult: any = null;

    // 换源搜索缓存：一次请求只搜索一次，后续换源复用结果
    let toggleSearchCache: any[] | null = null;

    // 预先启动歌词获取（并行）
    const lyricPromise = getLyricForMusicUrl(body, songId, name, singer, originalSource);

    // 步骤2：依次尝试每个脚本
    for (const currentScriptId of sortedIds) {
      const currentScript = allScripts.find(s => s.id === currentScriptId);
      if (!currentScript) continue;

      scriptId = currentScriptId;
      scriptName = currentScript.name;
      const startTime = Date.now();

      let rawScript: string | null = null;
      try { rawScript = await storage.getScriptRaw(currentScriptId); } catch (_e) {}
      if (!rawScript) { triedScripts.push({ scriptId: currentScriptId, scriptName: currentScript.name, message: '无法获取脚本内容', responseTime: Date.now() - startTime }); continue; }

      console.log(`[API] Initializing script ${currentScript.name}...`);
      let runner: ScriptRunner | undefined;
      try {
        runner = await getOrCreateRunner({ id: currentScriptId, name: currentScript.name, rawScript });
        console.log(`[API] Script ${currentScript.name} initialized OK`);
      } catch (error: any) {
        const diag = (runner as any)._featureDiagnostic ? ' | features: ' + (runner as any)._featureDiagnostic : '';
        const initErr = (runner as any)._scriptInitError || '';
        console.log(`[API] Script ${currentScript.name} init FAILED:`, error.message, '| diag:', diag, '| initErr:', initErr);
        triedScripts.push({ scriptId: currentScriptId, scriptName: currentScript.name, message: error.message + diag + (initErr ? ' | raw:' + initErr : ''), responseTime: Date.now() - startTime });
        await storage.updateScriptStats(currentScriptId, false, Date.now() - startTime);
        await storage.recordScriptFailure(currentScriptId); continue;
      }

      try {
        const musicInfoSource = body.musicInfo?.source || body.source || 'unknown';
        const result = await runner.request({
          source: musicInfoSource, action: 'musicUrl',
          info: {
            type: body.quality,
            musicInfo: {
              id: songId,
              name,
              singer,
              source: musicInfoSource,
              songmid: songId,
              interval: body.interval || body.musicInfo?.interval || 0,
              meta: {
                songId: songId,
                albumName: body.albumName || body.musicInfo?.albumName || body.musicInfo?.album || '',
                picUrl: body.picUrl || body.musicInfo?.picUrl || null,
                hash: body.hash || body.musicInfo?.hash || body.musicInfo?.songmid || '',
                strMediaMid: body.strMediaMid || body.musicInfo?.strMediaMid || '',
                copyrightId: body.copyrightId || body.musicInfo?.copyrightId || '',
              },
              albumName: body.albumName || body.musicInfo?.albumName || body.musicInfo?.album || '',
              img: body.picUrl || body.musicInfo?.picUrl || body.musicInfo?.img || '',
              typeUrl: {},
              albumId: body.albumId || body.musicInfo?.albumId || '',
              types: body.types || body.qualitys || body.musicInfo?.qualitys || [],
              _types: {},
              hash: body.hash || body.musicInfo?.hash || body.musicInfo?.songmid || '',
              copyrightId: body.copyrightId || body.musicInfo?.copyrightId || '',
              strMediaMid: body.strMediaMid || body.musicInfo?.strMediaMid || '',
              albumMid: body.albumMid || body.musicInfo?.albumMid || '',
              songId: body.songId || body.musicInfo?.songId || songId,
              lrcUrl: body.lrcUrl || body.musicInfo?.lrcUrl || '',
              mrcUrl: body.mrcUrl || body.musicInfo?.mrcUrl || '',
              trcUrl: body.trcUrl || body.musicInfo?.trcUrl || ''
            }
          },
          timeoutMs: scriptTimeouts.get(currentScriptId),
        });
        const responseTime = Date.now() - startTime;

        if (result.data.url) {
          if (result.data.url.endsWith('2149972737147268278.mp3')) {
            console.log(`[API] ⚠️ 检测到无效URL(黑名单)，触发换源`);
            triedScripts.push({ scriptId: currentScriptId, scriptName: currentScript.name, message: '黑名单URL', responseTime });
            await storage.updateScriptStats(currentScriptId, false, responseTime);
            await storage.updateSourceStats(currentScriptId, originalSource, false);
            if (allowToggleSource) {
              const elapsedMs = responseTime;
              if (toggleSearchCache === null) {
                const keyword = `${name} ${singer}`.trim();
                const allSources = ['kw', 'kg', 'tx', 'wy', 'mg'];
                const sourcesToTry = allSources.filter(s => !excludeSources.includes(s));
                toggleSearchCache = await performToggleSearch(keyword, sourcesToTry, name, singer, body, '[ToggleSource]');
                console.log(`[ToggleSource] 首次搜索完成，共 ${toggleSearchCache.length} 个匹配`);
              }
              const toggleResult = await tryToggleSourceInternal(body, songId, name, singer, originalSource, excludeSources, currentScriptId, currentScript.name, runner, storage, elapsedMs, toggleSearchCache);
              if (toggleResult.success && toggleResult.url) {
                const toggleLyric = await Promise.race([
                  getLyricForMatchedSong(toggleResult.matchedSong),
                  new Promise<any>(r => setTimeout(() => r({ lyric: '', tlyric: '', rlyric: '', lxlyric: '' }), 2000))
                ]);
                await incrementShareUsage(env?.DB);
                return jsonResponse({
                  url: toggleResult.url, type: toggleResult.type || body.quality, source: toggleResult.newSource,
                  quality: body.quality, lyric: toggleLyric.lyric, tlyric: toggleLyric.tlyric, rlyric: toggleLyric.rlyric, lxlyric: toggleLyric.lxlyric, cached: false,
fallback: { toggled: true, originalSource, newSource: toggleResult.newSource, matchedSong: toggleResult.matchedSong || { name: toggleResult.matchedName, singer: toggleResult.matchedSinger } },
scriptId: currentScriptId, scriptName: currentScript.name,
triedScripts: triedScripts.length > 0 ? triedScripts : undefined,
}, 200, '获取成功（换源）');
}
}
// 换源成功也计入 share usage
await incrementShareUsage(env?.DB);
const circuitTrippedBl = await storage.recordScriptFailure(currentScriptId);
            if (circuitTrippedBl) console.log(`[API] 脚本 ${currentScript.name} 已触发熔断（黑名单URL）`);
            lastResult = { scriptId: currentScriptId, scriptName: currentScript.name, message: '黑名单URL' };
            continue;
          }

          await storage.updateScriptStats(currentScriptId, true, responseTime);
          await storage.recordScriptSuccess(currentScriptId);
          await storage.updateSourceStats(currentScriptId, originalSource, true);

          const lyricResult = await Promise.race([lyricPromise, new Promise<any>(r => setTimeout(() => r({ lyric: '', tlyric: '', rlyric: '', lxlyric: '' }), 2000))]);

          // 计入 share usage（分享者自己调用也计数）
          await incrementShareUsage(env?.DB);

          return jsonResponse({
            url: result.data.url, type: result.data.type || body.quality, source: originalSource,
            quality: body.quality, lyric: lyricResult.lyric, tlyric: lyricResult.tlyric,
            rlyric: lyricResult.rlyric, lxlyric: lyricResult.lxlyric,
            cached: false, fallback: { toggled: false, originalSource },
            scriptId: currentScriptId, scriptName: currentScript.name,
            triedScripts: triedScripts.length > 0 ? triedScripts : undefined,
          }, 200, '获取成功');
        }
        throw new Error('获取播放URL失败');
      } catch (error: any) {
        const responseTime = Date.now() - startTime;
        const _diag = runner.getDiagnostics ? runner.getDiagnostics() : null;
        console.log(`[API] ❌ 脚本 ${currentScript.name} 失败: ${error.message}, 耗时: ${responseTime}ms`);
        triedScripts.push({ scriptId: currentScriptId, scriptName: currentScript.name, message: error.message || '未知错误', responseTime, diagnostics: _diag });

        if (allowToggleSource) {
          console.log(`[API] 🔄 调用 tryToggleSourceInternal (原始源: ${originalSource})`);
          const elapsedMs = responseTime;
          if (toggleSearchCache === null) {
            const keyword = `${name} ${singer}`.trim();
            const allSources = ['kw', 'kg', 'tx', 'wy', 'mg'];
            const sourcesToTry = allSources.filter(s => !excludeSources.includes(s));
            toggleSearchCache = await performToggleSearch(keyword, sourcesToTry, name, singer, body, '[ToggleSource]');
            console.log(`[ToggleSource] 首次搜索完成，共 ${toggleSearchCache.length} 个匹配`);
          }
          const toggleResult = await tryToggleSourceInternal(body, songId, name, singer, originalSource, excludeSources, currentScriptId, currentScript.name, runner, storage, elapsedMs, toggleSearchCache);
          if (toggleResult.success && toggleResult.url) {
            console.log(`[API] ✅ tryToggleSourceInternal 换源成功: ${originalSource} -> ${toggleResult.newSource}`);
            const toggleLyric = await Promise.race([
              getLyricForMatchedSong(toggleResult.matchedSong),
              new Promise<any>(r => setTimeout(() => r({ lyric: '', tlyric: '', rlyric: '', lxlyric: '' }), 2000))
            ]);
            await incrementShareUsage(env?.DB);
            return jsonResponse({
              url: toggleResult.url, type: toggleResult.type || body.quality, source: toggleResult.newSource,
              quality: body.quality, lyric: toggleLyric.lyric, tlyric: toggleLyric.tlyric, rlyric: toggleLyric.rlyric, lxlyric: toggleLyric.lxlyric, cached: false,
fallback: { toggled: true, originalSource, newSource: toggleResult.newSource, matchedSong: toggleResult.matchedSong || { name: toggleResult.matchedName, singer: toggleResult.matchedSinger } },
scriptId: currentScriptId, scriptName: currentScript.name,
triedScripts: triedScripts.length > 0 ? triedScripts : undefined,
}, 200, '获取成功（换源）');
}
// 换源成功也计入 share usage
await incrementShareUsage(env?.DB);
console.log(`[API] tryToggleSourceInternal 失败: ${toggleResult.message}`);
        } else {
          console.log(`[API] 换源已禁用(allowToggleSource=false)`);
        }

        await storage.updateScriptStats(currentScriptId, false, responseTime);
        await storage.updateSourceStats(currentScriptId, originalSource, false);
        const circuitTripped = await storage.recordScriptFailure(currentScriptId);
        if (circuitTripped) console.log(`[API] 🔴 脚本 ${currentScript.name} 已触发熔断`);

        lastResult = { scriptId: currentScriptId, scriptName: currentScript.name, message: error.message };
      }
    }

    if (allowToggleSource && triedScripts.length > 0) {
      console.log(`[API] 🔄 所有支持 ${originalSource} 的脚本均失败(${triedScripts.length}个)，触发最终跨脚本换源...`);
      try {
        const fallbackResp = await handleForceToggle(body, songId, name, singer, originalSource, [], storage);
        return fallbackResp;
      } catch (e: any) {
        console.log(`[API] 最终跨脚本换源也失败: ${e.message}`);
      }
    }

    return jsonResponse(null, 500, '所有脚本均获取失败', { source: originalSource, scriptId: lastResult?.scriptId || 'unknown', scriptName: lastResult?.scriptName || 'unknown', triedScripts });
  } catch (error: any) {
    return jsonResponse(null, 500, error.message || 'Internal Server Error', { scriptId, scriptName });
  }
}

// ==================== 强制换源（无脚本支持原始源时） ====================
async function fastBuiltinMusicUrl(source: string, quality: string, songmid: string, name: string, singer: string): Promise<string | null> {
  const keyword = `${name} - ${singer}`;
  if (source === 'kw') {
    try {
      const searchResp = await fetch(`http://search.kuwo.cn/r.s?all=${encodeURIComponent(keyword)}&ft=music&itemset=web_2013&client=kt&rformat=json&encoding=utf8`, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'http://www.kuwo.cn' }
      });
      const searchData = await searchResp.json() as any;
      const abslist = searchData?.abslist?.filter((s: any) => s?.RID) || [];
      if (abslist.length > 0) {
        const rid = abslist[0].RID;
        const proxyResp = await fetch(`https://api.nobb.cc/kuwo/url?rid=${rid}&br=${quality === 'flac' ? '999k' : quality === '320k' ? '320kmp3' : '128kmp3'}`);
        const proxyData = await proxyResp.json() as any;
        if (proxyData.code === 200 && proxyData.data?.url) return proxyData.data.url;
      }
    } catch (_e) {}
    throw new Error('kw fast path failed');
  }
  if (source === 'kg') {
    try {
      const searchResp = await fetch(`http://msearchcdn.kugou.com/api/v3/search/song?format=json&keyword=${encodeURIComponent(keyword)}&page=1&pagesize=5`, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'KG-RC': '1' }
      });
      const searchData = await searchResp.json() as any;
      const hash = searchData?.data?.info?.[0]?.hash;
      const albumId = searchData?.data?.info?.[0]?.album_id;
      if (hash && albumId) {
        const playResp = await fetch(`https://wwwapi.kugou.com/yy/index.php?r=play/getdata&hash=${hash}&album_id=${albumId}&mid=1_1`, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.kugou.com/', 'Origin': 'https://www.kugou.com' }
        });
        const playData = await playResp.json() as any;
        if (playData.data?.play_url) return playData.data.play_url;
      }
      throw new Error('kg play API blocked, try kw');
    } catch (kgErr: any) {
      console.log(`[FastPath] kg failed: ${kgErr.message}, falling back to kw...`);
      return fastBuiltinMusicUrl('kw', quality, songmid, name, singer);
    }
  }
  throw new Error(`fast path unsupported source: ${source}`);
}

async function handleForceToggle(
  body: any, songId: string, name: string, singer: string,
  originalSource: string, excludeSources: string[], storage: ScriptStorage
): Promise<Response> {
  const allScripts = await storage.getScripts();
  const toggleSources = ['kw', 'kg', 'tx', 'wy', 'mg'].filter(s => s !== originalSource && !excludeSources.includes(s));
  console.log(`[ForceToggle] 原始源 ${originalSource} 无脚本，尝试: [${toggleSources.join(',')}]`);
  const forceToggleLogs: string[] = [];
  // 预先启动歌词获取（使用原始源，因为新源的 songId 可能不正确）
  const ftLyricPromise = getLyricForMusicUrl(body, songId, name, singer, originalSource);

  for (const trySource of toggleSources) {
    for (const s of allScripts) {
      if (!s.supportedSources.includes(trySource)) {
        console.log(`[ForceToggle] ⏭️ ${s.name} 不支持 ${trySource}，但仍尝试（builtin可能支持）`);
      }
      const isTripped = await storage.isScriptCircuitBreakerTripped(s.id);
      if (isTripped) { console.log(`[ForceToggle] 跳过熔断脚本 ${s.name}`); forceToggleLogs.push(`跳过熔断: ${s.name}+${trySource}`); continue; }

      let rawScript: string | null = null;
      try { rawScript = await storage.getScriptRaw(s.id); } catch (_e) {}
      if (!rawScript) { forceToggleLogs.push(`无rawScript: ${s.name}+${trySource}`); continue; }

      if (trySource === 'kw' || trySource === 'kg') {
        console.log(`[ForceToggle] ⚡ 快速路径 ${s.name} + ${trySource} (跳过QuickJS)...`);
        try {
          const fastUrl = await fastBuiltinMusicUrl(trySource, body.quality, songId || '', name, singer);
          if (fastUrl) {
            await storage.updateScriptStats(s.id, true, 0);
            await storage.recordScriptSuccess(s.id);
            await incrementShareUsage(env?.DB);
const ftLyric = await Promise.race([ftLyricPromise, new Promise<any>(r => setTimeout(() => r({ lyric: '', tlyric: '', rlyric: '', lxlyric: '' }), 2000))]);
return jsonResponse({ url: fastUrl, type: body.quality, source: trySource, quality: body.quality, lyric: ftLyric.lyric, tlyric: ftLyric.tlyric, rlyric: ftLyric.rlyric, lxlyric: ftLyric.lxlyric, cached: false, fallback: { toggled: true, originalSource, newSource: trySource }, scriptId: s.id, scriptName: s.name }, 200, '获取成功（快速换源）');
          }
        } catch (fe: any) {
          console.log(`[ForceToggle] ⚡ 快速路径失败: ${fe.message?.substring(0, 100)}, 回退到完整路径...`);
          forceToggleLogs.push(`快速路径失败: ${s.name}+${trySource}: ${fe.message?.substring(0, 80)}`);
        }
      }

      console.log(`[ForceToggle] 🔄 尝试 ${s.name} + ${trySource} 源...`);
      const runner = await getOrCreateRunner({ id: s.id, name: s.name, rawScript });
      try {
        console.log(`[ForceToggle] ✅ ${s.name} 初始化成功，发起请求...`);
        const result = await runner.request({
          source: trySource, action: 'musicUrl',
          info: { type: body.quality, musicInfo: { id: songId, name, singer, source: trySource, songmid: songId, meta: { songId: songId } } },
        });
        console.log(`[ForceToggle] 📊 ${s.name}+${trySource} 结果: url=${!!result.data.url}, data=${JSON.stringify(result.data || {}).substring(0, 100)}`);
        if (result.data.url) {
          await storage.updateScriptStats(s.id, true, 0);
          await storage.recordScriptSuccess(s.id);
await incrementShareUsage(env?.DB);
const ftLyric = await Promise.race([ftLyricPromise, new Promise<any>(r => setTimeout(() => r({ lyric: '', tlyric: '', rlyric: '', lxlyric: '' }), 2000))]);
return jsonResponse({ url: result.data.url, type: result.data.type || body.quality, source: trySource, quality: body.quality, lyric: ftLyric.lyric, tlyric: ftLyric.tlyric, rlyric: ftLyric.rlyric, lxlyric: ftLyric.lxlyric, cached: false, fallback: { toggled: true, originalSource, newSource: trySource }, scriptId: s.id, scriptName: s.name }, 200, '获取成功（强制换源）');
}
forceToggleLogs.push(`${s.name}+${trySource}: url为空`);
      } catch (ftErr: any) {
        console.log(`[ForceToggle] ❌ ${s.name}+${trySource} 异常: ${ftErr.message?.substring(0, 120)}`);
        const diag = runner.getDiagnostics ? runner.getDiagnostics() : null;
        forceToggleLogs.push(`${s.name}+${trySource} 异常: ${ftErr.message?.substring(0, 80)}`);
        if (diag?.keyLogs) forceToggleLogs.push(...diag.keyLogs.slice(-20));
      }
    }
  }

  console.log(`[ForceToggle] 所有正常脚本失败，尝试降级(忽略熔断)...`);
  for (const s of allScripts) {
    if (!s.supportedSources.includes('wy')) continue;
    let rawScript: string | null = null;
    try { rawScript = await storage.getScriptRaw(s.id); } catch (_e) {}
    if (!rawScript) continue;
    const runner = await getOrCreateRunner({ id: s.id, name: s.name, rawScript });
    const degradeStartTime = Date.now();
    try {
      const result = await runner.request({ source: 'wy', action: 'musicUrl', info: { type: body.quality, musicInfo: { id: songId || '', name, singer, source: 'wy', songmid: songId || '', meta: { songId: songId || '' } } } });
      const degradeResponseTime = Date.now() - degradeStartTime;
      if (result.data.url) {
        await storage.updateScriptStats(s.id, true, degradeResponseTime);
        await storage.recordScriptSuccess(s.id);
        await storage.updateSourceStats(s.id, 'wy', true);
        await incrementShareUsage(env?.DB);
const ftLyric = await Promise.race([ftLyricPromise, new Promise<any>(r => setTimeout(() => r({ lyric: '', tlyric: '', rlyric: '', lxlyric: '' }), 2000))]);
return jsonResponse({ url: result.data.url, type: result.data.type || body.quality, source: 'wy', quality: body.quality, lyric: ftLyric.lyric, tlyric: ftLyric.tlyric, rlyric: ftLyric.rlyric, lxlyric: ftLyric.lxlyric, cached: false, fallback: { toggled: true, originalSource, newSource: 'wy' }, scriptId: s.id, scriptName: s.name }, 200, '获取成功（强制换源-降级）');
      }
      await storage.updateScriptStats(s.id, false, degradeResponseTime);
      await storage.updateSourceStats(s.id, 'wy', false);
      await storage.recordScriptFailure(s.id);
      const diag = runner.getDiagnostics ? runner.getDiagnostics() : null;
      forceToggleLogs.push(`降级wy: url为空`);
      if (diag?.keyLogs) forceToggleLogs.push(...diag.keyLogs.slice(-20));
    } catch (e: any) {
      const degradeResponseTime = Date.now() - degradeStartTime;
      await storage.updateScriptStats(s.id, false, degradeResponseTime);
      await storage.updateSourceStats(s.id, 'wy', false);
      await storage.recordScriptFailure(s.id);
      const diag = runner.getDiagnostics ? runner.getDiagnostics() : null;
      forceToggleLogs.push(`降级wy异常: ${e.message?.substring(0, 80)}`);
      if (diag?.keyLogs) forceToggleLogs.push(...diag.keyLogs.slice(-20));
    }
  }

  for (const s of allScripts) {
    if (!s.supportedSources.includes('kw')) continue;
    let rawScript: string | null = null;
    try { rawScript = await storage.getScriptRaw(s.id); } catch (_e) {}
    if (!rawScript) continue;
    const runner = await getOrCreateRunner({ id: s.id, name: s.name, rawScript });
    const degradeStartTime = Date.now();
    try {
      const result = await runner.request({ source: 'kw', action: 'musicUrl', info: { type: body.quality, musicInfo: { id: songId || '', name, singer, source: 'kw', songmid: songId || '', meta: { songId: songId || '' } } } });
      const degradeResponseTime = Date.now() - degradeStartTime;
      if (result.data.url) {
        await storage.updateScriptStats(s.id, true, degradeResponseTime);
        await storage.recordScriptSuccess(s.id);
        await storage.updateSourceStats(s.id, 'kw', true);
        await incrementShareUsage(env?.DB);
const ftLyric = await Promise.race([ftLyricPromise, new Promise<any>(r => setTimeout(() => r({ lyric: '', tlyric: '', rlyric: '', lxlyric: '' }), 2000))]);
return jsonResponse({ url: result.data.url, type: result.data.type || body.quality, source: 'kw', quality: body.quality, lyric: ftLyric.lyric, tlyric: ftLyric.tlyric, rlyric: ftLyric.rlyric, lxlyric: ftLyric.lxlyric, cached: false, fallback: { toggled: true, originalSource, newSource: 'kw' }, scriptId: s.id, scriptName: s.name }, 200, '获取成功（强制换源-降级）');
      }
      await storage.updateScriptStats(s.id, false, degradeResponseTime);
      await storage.updateSourceStats(s.id, 'kw', false);
      await storage.recordScriptFailure(s.id);
      const diag = runner.getDiagnostics ? runner.getDiagnostics() : null;
      forceToggleLogs.push(`降级kw: url为空`);
      if (diag?.keyLogs) forceToggleLogs.push(...diag.keyLogs.slice(-20));
    } catch (e: any) {
      const degradeResponseTime = Date.now() - degradeStartTime;
      await storage.updateScriptStats(s.id, false, degradeResponseTime);
      await storage.updateSourceStats(s.id, 'kw', false);
      await storage.recordScriptFailure(s.id);
      const diag = runner.getDiagnostics ? runner.getDiagnostics() : null;
      forceToggleLogs.push(`降级kw异常: ${e.message?.substring(0, 80)}`);
      if (diag?.keyLogs) forceToggleLogs.push(...diag.keyLogs.slice(-20));
    } finally { /* 不 dispose — runner 被缓存复用 */ }
  }

  return jsonResponse(null, 412, `没有支持 ${originalSource} 源的脚本且换源失败`);
}

// ==================== 换源逻辑 ====================

interface ToggleResult {
  success: boolean;
  url?: string;
  type?: string;
  newSource?: string;
  matchedName?: string;
  matchedSinger?: string;
  matchedSong?: any;
  message: string;
}

/**
 * 执行换源搜索（一次请求只调用一次，结果缓存复用）
 * 对所有候选源并行搜索，按歌名+歌手精确匹配最佳结果。
 */
async function performToggleSearch(
  keyword: string, sourcesToTry: string[],
  name: string, singer: string, body: any,
  logPrefix: string = '[ToggleSearch]'
): Promise<any[]> {
  let matchedSongs: any[] = [];
  try {
    const searchPromises = sourcesToTry.map(async (source) => {
      try {
        const results = await searchService.search(keyword, source, 1, 10);
        const platformResult = results.find(r => r.platform === source);
        return { source, results: platformResult?.results || [] };
      } catch (e: any) { return { source, results: [] as any[] }; }
    });
    const searchResultsArray = await Promise.all(searchPromises);
    for (const { source, results } of searchResultsArray) {
      if (results.length === 0 || (results.length === 1 && !results[0].name)) continue;
      const matched = findBestMatch(results, name, singer, body.interval || body.musicInfo?.interval, body.albumName || body.musicInfo?.albumName || body.musicInfo?.album || '');
      if (matched) { matchedSongs.push({ ...matched, source }); console.log(`${logPrefix} 搜索匹配 ${source}: ${matched.name} - ${matched.singer} (${(matched.matchScore || 0).toFixed(2)})`); }
    }
  } catch (e: any) { console.log(`${logPrefix} 搜索阶段异常: ${e.message}`); }
  return matchedSongs;
}

async function tryToggleSourceInternal(
  body: any, songId: string, name: string, singer: string,
  originalSource: string, excludeSources: string[],
  scriptId: string, scriptName: string, runner: ScriptRunner,
  storage: ScriptStorage, elapsedMs: number,
  matchedSongs: any[]
): Promise<ToggleResult> {
  console.log(`[ToggleSource] === 函数被调用! originalSource=${originalSource}, name=${name}, singer=${singer}, songId=${songId} ===`);
  const keyword = `${name} ${singer}`.trim();
  const allSources = ['kw', 'kg', 'tx', 'wy', 'mg'];
  // 关键修复：换源时也包含原始源！因为原始 songId 可能是错误的（如过期/跨平台ID），
  // 通过搜索按歌名+歌手可以在原始源上找到正确的 songId。
  // 例如：kw 原始 ID 667425914 是错误的，但搜索 "1206 Edan 吕爵安" 能找到正确 ID 573061660。
  const sourcesToTry = allSources.filter(s => !excludeSources.includes(s));
  if (sourcesToTry.length === 0) return { success: false, message: '没有可用的换源源' };

  console.log(`[ToggleSource] 开始换源: "${keyword}", 原始源: ${originalSource}, 候选(含原始源搜索): [${sourcesToTry.join(',')}], 已耗时: ${elapsedMs}ms, 搜索结果: ${matchedSongs.length}个匹配`);

  // 使用传入的搜索结果（已缓存，避免重复搜索）
  let songsToTry = matchedSongs;

  // 策略2：搜索无结果时，直接用原歌曲信息重试其他源（适用于聚合脚本如juhe）
  // 注意：策略2排除原始源，因为用原始 songId 在原始源上已经失败了，重试无意义
  if (songsToTry.length === 0) {
    console.log('[ToggleSource] 搜索未找到匹配，切换到直接重试模式（用原歌曲信息尝试所有候选源）');
    songsToTry = [];
    const fallbackSources = sourcesToTry.filter(s => s !== originalSource);
    for (const src of fallbackSources) {
      songsToTry.push({ name, singer, source: src, songmid: songId || '', id: songId || '', hash: songId || '', interval: body.interval || body.musicInfo?.interval || '', albumName: body.albumName || body.musicInfo?.albumName || '', picUrl: body.picUrl || '', musicInfo: { name, singer, source: src, songmid: songId }, matchScore: 0.5 });
    }
  }

  // 按匹配度和成功率排序
  const sourceStats = await storage.getSourceStats();
  const sortedSongs = sortByMatchAndSuccessRate(songsToTry, sourceStats[scriptId] || {});

  for (const song of sortedSongs) {
    const newSource = song.source;
    const newSongId = song.musicInfo?.songmid || song.songmid || song.id || song.hash;
    // 跳过与原始请求完全相同的源+ID组合（已经试过且失败了）
    if (newSource === originalSource && newSongId === songId) {
      console.log(`[ToggleSource] 跳过原始请求组合: ${newSource}/${newSongId}（已失败）`);
      continue;
    }
    console.log(`[ToggleSource] 尝试 ${newSource} (songId: ${newSongId || '(原)'})`);

    try {
      const result = await runner.request({
        source: newSource, action: 'musicUrl',
        info: { type: body.quality, musicInfo: { id: newSongId || songId, name: song.name, singer: song.singer, source: newSource,
          songmid: newSongId || songId, interval: song.interval || '',
          meta: { songId: newSongId || songId },
          albumName: song.albumName || '', img: song.picUrl || '' }},
        timeoutMs: 8000,
      });

      if (result.data.url) {
        // 检查黑名单 URL（与主流程一致）
        if (result.data.url.endsWith('2149972737147268278.mp3')) {
          console.log(`[ToggleSource] ⚠️ ${newSource} 返回黑名单URL，跳过`);
          await storage.updateSourceStats(scriptId, newSource, false);
          continue;
        }
        await storage.updateSourceStats(scriptId, newSource, true);
        await storage.updateScriptStats(scriptId, true, 0);
        await storage.recordScriptSuccess(scriptId);
        return { success: true, url: result.data.url, type: result.data.type, newSource, matchedName: song.name, matchedSinger: song.singer,
          matchedSong: {
            id: song.musicInfo?.songmid || song.songmid || song.id || song.hash || '',
            songmid: song.musicInfo?.songmid || song.songmid || song.id || '',
            hash: song.musicInfo?.hash || song.hash || '',
            copyrightId: song.musicInfo?.copyrightId || song.copyrightId || '',
            name: song.name,
            singer: song.singer,
            source: newSource,
            interval: song.interval || '',
            albumName: song.albumName || song.album || '',
          },
          message: 'ok' };
      }
      await storage.updateSourceStats(scriptId, newSource, false);
    } catch (e: any) {
      console.log(`[ToggleSource] ${newSource} 异常: ${e.message}`);
      await storage.updateSourceStats(scriptId, newSource, false);
    }
  }

  return { success: false, message: '所有音源均获取失败' };
}

function findBestMatch(results: any[], targetName: string, targetSinger: string, targetInterval?: string, targetAlbumName?: string): any | null {
  if (results.length === 0) return null;

  const singersRxp = /、|&|;|；|\/|,|，|\|/;
  const sortSingle = (s: string) => singersRxp.test(s) ? s.split(singersRxp).sort((a, b) => a.localeCompare(b)).join('、') : (s || '');
  const filterStr = (s: string) => typeof s === 'string' ? s.replace(/\s|'|\.|,|，|&|"|、|\(|\)|（|）|`|~|-|<|>|\||\/|\]|\[|!|！/g, '').toLowerCase() : String(s || '').toLowerCase();
  const trimStr = (s: string) => typeof s === 'string' ? s.trim() : (s || '');
  const getIntv = (intv: string | number | undefined): number => {
    if (!intv) return 0;
    if (typeof intv === 'number') return intv;
    const parts = intv.split(':'); let result = 0, unit = 1;
    while (parts.length) { result += parseInt(parts.pop() || '0') * unit; unit *= 60; }
    return result;
  };

  const fName = filterStr(targetName), fSinger = filterStr(sortSingle(targetSinger)), fAlbum = filterStr(targetAlbumName || ''), fIntv = getIntv(targetInterval);

  const processed = results.map(item => ({
    ...item,
    fName: filterStr(trimStr(item.name || '')),
    fSinger: filterStr(sortSingle(trimStr(item.singer || ''))),
    fAlbum: filterStr(trimStr(item.albumName || '')),
    fIntv: getIntv(item.interval),
    intervalMatch: Math.abs((getIntv(item.interval) || fIntv) - (fIntv || getIntv(item.interval))) < 5 && !!fIntv,
    nameMatch: filterStr(trimStr(item.name || '')) === fName,
    singerMatch: filterStr(sortSingle(trimStr(item.singer || ''))) === fSinger,
    albumMatch: filterStr(trimStr(item.albumName || '')) === fAlbum,
  }));

  const sortMusic = (list: any[], fn: (item: any) => boolean) => ([...list.filter(fn), ...list.filter(item => !fn(item))]);
  let sorted = [...processed];
  sorted = sortMusic(sorted, i => i.singerMatch && i.nameMatch && i.intervalMatch);
  sorted = sortMusic(sorted, i => i.nameMatch && i.singerMatch && i.fAlbum === fAlbum);
  sorted = sortMusic(sorted, i => i.singerMatch && i.nameMatch);
  sorted = sortMusic(sorted, i => i.nameMatch && i.intervalMatch);
  sorted = sortMusic(sorted, i => i.singerMatch && i.intervalMatch);
  sorted = sortMusic(sorted, i => i.intervalMatch);
  sorted = sortMusic(sorted, i => i.nameMatch);
  sorted = sortMusic(sorted, i => i.singerMatch);

  const best = sorted[0];
  if (!best) return null;

  let score = 0;
  if (best.nameMatch) score += 0.4; else if (fName.includes(best.fName) || best.fName.includes(fName)) score += 0.2;
  if (best.singerMatch) score += 0.3; else if (fSinger.includes(best.fSinger) || best.fSinger.includes(fSinger)) score += 0.15;
  if (best.intervalMatch) score += 0.2;
  if (fAlbum && best.albumMatch) score += 0.1;
  score += Math.max(0, (processed.length - 1) / processed.length * 0.1);

  if (score < 0.3 && !best.intervalMatch) return null;
  return { ...best, matchScore: score };
}

function sortByMatchAndSuccessRate(songs: any[], sourceStats: { [source: string]: { success: number; fail: number } }): any[] {
  const getRate = (src: string) => { const s = sourceStats[src]; if (!s) return 0.5; const t = s.success + s.fail; return t === 0 ? 0.5 : s.success / t; };
  return songs.sort((a, b) => {
    const sA = (a.matchScore || 0) * 0.5 + getRate(a.source) * 0.3 + Math.min((sourceStats[a.source]?.success || 0) / 100, 0.2);
    const sB = (b.matchScore || 0) * 0.5 + getRate(b.source) * 0.3 + Math.min((sourceStats[b.source]?.success || 0) / 100, 0.2);
    return sB - sA;
  });
}

async function getLyricForMusicUrl(body: any, songId: string, name: string, singer: string, source: string): Promise<{ lyric: string; tlyric: string; rlyric: string; lxlyric: string }> {
  try {
    const musicInfo: any = { source };
    switch (source) {
      case 'kw': musicInfo.songmid = songId; break;
      case 'kg': musicInfo.hash = songId; musicInfo.name = name; break;
      case 'tx': musicInfo.songId = songId; break;
      case 'wy': musicInfo.songId = songId; break;
      case 'mg': musicInfo.copyrightId = songId; musicInfo.name = name; musicInfo.singer = singer; break;
    }
    const result = await lyricService.getLyric(musicInfo);
    return { lyric: result.lyric || '', tlyric: result.tlyric || '', rlyric: result.rlyric || '', lxlyric: result.lxlyric || '' };
  } catch (_e) { return { lyric: '', tlyric: '', rlyric: '', lxlyric: '' }; }
}

/**
 * 根据换源后的 matchedSong 获取歌词
 * matchedSong 包含新源的 source、songmid、hash、copyrightId 等正确信息。
 * 不同源使用不同的 ID 字段获取歌词：
 *   kw → songmid, kg → hash, tx/wy → songId, mg → copyrightId
 */
async function getLyricForMatchedSong(matchedSong: any): Promise<{ lyric: string; tlyric: string; rlyric: string; lxlyric: string }> {
  if (!matchedSong || !matchedSong.source) return { lyric: '', tlyric: '', rlyric: '', lxlyric: '' };
  try {
    const source = matchedSong.source;
    const musicInfo: any = { source };
    switch (source) {
      case 'kw':
        musicInfo.songmid = matchedSong.songmid || matchedSong.id || '';
        break;
      case 'kg':
        musicInfo.hash = matchedSong.hash || matchedSong.id || '';
        musicInfo.name = matchedSong.name || '';
        break;
      case 'tx':
        musicInfo.songId = matchedSong.id || matchedSong.songmid || '';
        break;
      case 'wy':
        musicInfo.songId = matchedSong.id || matchedSong.songmid || '';
        break;
      case 'mg':
        musicInfo.copyrightId = matchedSong.copyrightId || matchedSong.id || '';
        musicInfo.name = matchedSong.name || '';
        musicInfo.singer = matchedSong.singer || '';
        break;
      default:
        return { lyric: '', tlyric: '', rlyric: '', lxlyric: '' };
    }
    const result = await lyricService.getLyric(musicInfo);
    return { lyric: result.lyric || '', tlyric: result.tlyric || '', rlyric: result.rlyric || '', lxlyric: result.lxlyric || '' };
  } catch (_e) { return { lyric: '', tlyric: '', rlyric: '', lxlyric: '' }; }
}

// ==================== inline 脚本换源（无需 storage） ====================

/**
 * 为 inline 脚本执行换源逻辑（不依赖 ScriptStorage 统计）
 *
 * 流程与 tryToggleSourceInternal 一致，但跳过所有 storage 统计更新。
 * 适用于 /share/music-url 中客户端传入的脚本。
 */
async function tryToggleSourceForInline(
  body: any, songId: string, name: string, singer: string,
  originalSource: string, excludeSources: string[],
  scriptId: string, scriptName: string, runner: ScriptRunner,
  elapsedMs: number,
  matchedSongs: any[]
): Promise<ToggleResult> {
  console.log(`[ShareToggle] === inline换源 originalSource=${originalSource}, name=${name}, singer=${singer}, songId=${songId} ===`);
  const keyword = `${name} ${singer}`.trim();
  const allSources = ['kw', 'kg', 'tx', 'wy', 'mg'];
  // 关键修复：换源时也包含原始源！原始 songId 可能是错误的，
  // 通过搜索按歌名+歌手可以在原始源上找到正确的 songId。
  const sourcesToTry = allSources.filter(s => !excludeSources.includes(s));
  if (sourcesToTry.length === 0) return { success: false, message: '没有可用的换源源' };

  console.log(`[ShareToggle] 开始换源: "${keyword}", 原始源: ${originalSource}, 候选(含原始源搜索): [${sourcesToTry.join(',')}], 已耗时: ${elapsedMs}ms, 搜索结果: ${matchedSongs.length}个匹配`);

  // 使用传入的搜索结果（已缓存，避免重复搜索）
  let songsToTry = matchedSongs;

  // 策略2：搜索无结果时，直接用原歌曲信息重试其他源（适用于聚合脚本如juhe）
  // 注意：策略2排除原始源，因为用原始 songId 在原始源上已经失败了，重试无意义
  if (songsToTry.length === 0) {
    console.log('[ShareToggle] 搜索未找到匹配，切换到直接重试模式（用原歌曲信息尝试所有候选源）');
    songsToTry = [];
    const fallbackSources = sourcesToTry.filter(s => s !== originalSource);
    for (const src of fallbackSources) {
      songsToTry.push({ name, singer, source: src, songmid: songId || '', id: songId || '', hash: songId || '', interval: body.interval || body.musicInfo?.interval || '', albumName: body.albumName || body.musicInfo?.albumName || '', picUrl: body.picUrl || '', musicInfo: { name, singer, source: src, songmid: songId }, matchScore: 0.5 });
    }
  }

  // 排序（inline 脚本无历史统计，使用空统计）
  const sortedSongs = sortByMatchAndSuccessRate(songsToTry, {});

  for (const song of sortedSongs) {
    const newSource = song.source;
    const newSongId = song.musicInfo?.songmid || song.songmid || song.id || song.hash;
    // 跳过与原始请求完全相同的源+ID组合（已经试过且失败了）
    if (newSource === originalSource && newSongId === songId) {
      console.log(`[ShareToggle] 跳过原始请求组合: ${newSource}/${newSongId}（已失败）`);
      continue;
    }
    console.log(`[ShareToggle] 尝试 ${newSource} (songId: ${newSongId || '(原)'})`);

    try {
      const result = await runner.request({
        source: newSource, action: 'musicUrl',
        info: { type: body.quality, musicInfo: { id: newSongId || songId, name: song.name, singer: song.singer, source: newSource,
          songmid: newSongId || songId, interval: song.interval || '',
          meta: { songId: newSongId || songId },
          albumName: song.albumName || '', img: song.picUrl || '' }},
        timeoutMs: 8000,
      });

      if (result.data.url) {
        // 检查黑名单 URL（与主流程一致）
        if (result.data.url.endsWith('2149972737147268278.mp3')) {
          console.log(`[ShareToggle] ⚠️ ${newSource} 返回黑名单URL，跳过`);
          continue;
        }
        console.log(`[ShareToggle] ✅ 换源成功: ${originalSource} -> ${newSource}`);
        return { success: true, url: result.data.url, type: result.data.type, newSource, matchedName: song.name, matchedSinger: song.singer,
          matchedSong: {
            id: song.musicInfo?.songmid || song.songmid || song.id || song.hash || '',
            songmid: song.musicInfo?.songmid || song.songmid || song.id || '',
            hash: song.musicInfo?.hash || song.hash || '',
            copyrightId: song.musicInfo?.copyrightId || song.copyrightId || '',
            name: song.name,
            singer: song.singer,
            source: newSource,
            interval: song.interval || '',
            albumName: song.albumName || song.album || '',
          },
          message: 'ok' };
      }
    } catch (e: any) {
      console.log(`[ShareToggle] ${newSource} 异常: ${e.message}`);
    }
  }

  return { success: false, message: '所有音源均获取失败' };
}

// ==================== Share Plan Functions ====================
// PUBLIC_KEY 由环境变量独立配置，不再从 OWNER_KEY 计算
// sha256Hex 保留供未来扩展使用
async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ==================== 统一 app_data 存储（委托 AppDataStore） ====================
// 所有读写通过 AppDataStore 串行化，避免竞态；JSON 损坏时拒绝覆盖（方案 C+D）。
// 数据结构合并：scriptStats+sourceStats → script_stats, share_usage+api_calls → usage

let _appDataStore: AppDataStore | null = null;
function getStore(db: D1Database): AppDataStore {
  if (!_appDataStore || _appDataStore.isCorrupted()) {
    _appDataStore = new AppDataStore(db);
  }
  return _appDataStore;
}

async function getAppData(db: D1Database): Promise<AppData> {
  return getStore(db).get();
}

async function getShareConfig(db: D1Database): Promise<ShareConfig> {
  const data = await getAppData(db);
  return data.share_config;
}

async function setShareConfig(db: D1Database, config: ShareConfig): Promise<void> {
  await getStore(db).update(data => {
    data.share_config = config;
  });
}

async function getShareUsage(db: D1Database): Promise<{ date: string; count: number }> {
  const today = getTodayDateString();
  const data = await getAppData(db);
  return { date: today, count: data.usage.daily[today]?.share || 0 };
}

// 统一的计数器递增（通过 AppDataStore 串行化，无竞态）
async function incrementCounters(db: D1Database, incrementShare: boolean = false): Promise<number> {
  if (!db) return 0;
  const today = getTodayDateString();
  try {
    await getStore(db).update(data => {
      const entry = data.usage.daily[today] || { share: 0, api: 0 };
      entry.api += 1;
      data.usage.api_total += 1;
      if (incrementShare) {
        entry.share += 1;
      }
      data.usage.daily[today] = entry;
      cleanupUsageDaily(data);
    });
  } catch (e: any) {
    console.error("[incrementCounters] update failed:", e.message);
  }
  const data = await getAppData(db);
  return data.usage.daily[today]?.share || 0;
}

async function getApiCallStats(db: D1Database): Promise<Array<{ date: string; count: number }>> {
  const result: Array<{ date: string; count: number }> = [];
  const data = await getAppData(db);
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 3600 * 1000).toISOString().slice(0, 10);
    result.push({ date: d, count: data.usage.daily[d]?.api || 0 });
  }
  return result;
}

// 仅递增 share_usage 和 share_usage_total（通过 AppDataStore 串行化）
async function incrementShareUsage(db?: D1Database): Promise<number> {
  if (!db) return 0;
  const today = getTodayDateString();
  await getStore(db).update(data => {
    const entry = data.usage.daily[today] || { share: 0, api: 0 };
    entry.share += 1;
    data.usage.share_total += 1;
    data.usage.daily[today] = entry;
    cleanupUsageDaily(data);
  });
  const data = await getAppData(db);
  return data.usage.daily[today]?.share || 0;
}

async function handleShareStatus(request: Request, env: Env): Promise<Response> {
  let appData: AppData;
  try {
    appData = await getAppData(env.DB);
  } catch (e: any) {
    console.error("[handleShareStatus] getAppData failed, using defaults:", e.message);
    appData = defaultAppData();
  }
  const config = appData.share_config;
  const today = getTodayDateString();
  const usageCount = appData.usage.daily[today]?.share || 0;
  const pubKey = env.PUBLIC_KEY || "";
  return jsonResponse({
    status: "ok",
    serverVersion: SERVER_VERSION,
    serverVersionCode: SERVER_VERSION_CODE,
    platform: SERVER_PLATFORM,
    minClientVersion: MIN_CLIENT_VERSION,
    minClientVersionCode: MIN_CLIENT_VERSION_CODE,
    public_key: pubKey,
    share_status: config.status,
    node_id: config.node_id || "",
    daily_limit: config.daily_limit,
    current_usage: usageCount,
    remaining: Math.max(0, config.daily_limit - usageCount),
    service: "cf-phg-music-server",
  });
}

async function handleOwnerStatus(request: Request, env: Env): Promise<Response> {
let data: AppData;
try {
  data = await getAppData(env.DB);
} catch (e: any) {
  console.error("[handleOwnerStatus] getAppData failed, using defaults:", e.message);
  data = defaultAppData();
}
const config = data.share_config;
const today = getTodayDateString();
const usageCount = data.usage.daily[today]?.share || 0;
const pubKey = env.PUBLIC_KEY || "";
// 构建7天趋势（使用 usage.daily 中的 api 计数，与 api_call_total 一致）
const apiCallStats: Array<{ date: string; count: number }> = [];
for (let i = 6; i >= 0; i--) {
  const d = new Date(Date.now() - i * 24 * 3600 * 1000).toISOString().slice(0, 10);
  apiCallStats.push({ date: d, count: data.usage.daily[d]?.api || 0 });
}
return jsonResponse({
status: "ok",
serverVersion: SERVER_VERSION,
serverVersionCode: SERVER_VERSION_CODE,
platform: SERVER_PLATFORM,
minClientVersion: MIN_CLIENT_VERSION,
minClientVersionCode: MIN_CLIENT_VERSION_CODE,
public_key: pubKey,
share_status: config.status,
node_id: config.node_id || "",
daily_limit: config.daily_limit,
reserved_limit: config.reserved_limit,
current_usage: usageCount,
contributor_name: config.contributor_name,
remaining: Math.max(0, config.daily_limit - usageCount),
api_call_stats: apiCallStats,
api_call_total: data.usage.api_total || 0,
shared_since: config.shared_since || 0,
});
}

async function handleShareMusicUrl(request: Request, env: Env): Promise<Response> {
  try {
  const appData = await getAppData(env.DB);
  const config = appData.share_config;
  if (config.status !== 1) return jsonResponse(null, 403, "share mode is disabled");
  const today = getTodayDateString();
  const usageCount = appData.usage.daily[today]?.share || 0;
  if (usageCount >= config.daily_limit) return jsonResponse(null, 429, "daily share limit reached");
  const body = await request.json() as any;
  if (!body.source || !body.quality) return jsonResponse(null, 400, "missing: source, quality");
  const musicInfo = body.musicInfo || {};
  const songId = body.songmid || body.id || body.songId || musicInfo?.id || musicInfo?.songmid || "";
  const name = body.name || musicInfo?.name || '未知歌曲';
  const singer = body.singer || musicInfo?.singer || '未知歌手';
  const originalSource = body.source;

  // 换源控制参数（与 /api/music/url 一致）
  const allowToggleSource = body.allowToggleSource !== false;
  const excludeSources = body.excludeSources || [];

  // 预先启动歌词获取（并行）
  let lyricPromise = getLyricForMusicUrl(body, songId, name, singer, originalSource);

  // 统一构建 inline 脚本列表（兼容旧版单个 scriptContent 和新版 scripts 数组）
  const inlineScripts: { id: string; name: string; rawScript: string; isDefault?: boolean }[] = [];
  if (body.scripts && Array.isArray(body.scripts)) {
    // 新模式：多脚本数组
    for (const s of body.scripts) {
      if (!s.content) continue;
      let raw = s.content;
      try { raw = atob(raw); } catch (_e) {}
      inlineScripts.push({
        id: "share_inline_" + simpleHash(raw),
        name: s.name || 'Share Script',
        rawScript: raw,
        isDefault: s.isDefault === true,
      });
    }
  } else if (body.scriptContent) {
    // 向后兼容：单个脚本
    let raw = body.scriptContent;
    try { raw = atob(raw); } catch (_e) {}
    inlineScripts.push({
      id: "share_inline_" + simpleHash(raw),
      name: body.scriptName || 'Share Script',
      rawScript: raw,
      isDefault: true,
    });
  }

  // 按默认脚本优先排序（与 /api/music/url 的 getSortedScriptsBySuccessRate 一致）
  if (inlineScripts.length > 1) {
    inlineScripts.sort((a, b) => {
      if (a.isDefault && !b.isDefault) return -1;
      if (!a.isDefault && b.isDefault) return 1;
      return 0;
    });
    console.log(`[ShareMusicUrl] 脚本排序: ${inlineScripts.map(s => `${s.name}${s.isDefault ? '(默认)' : ''}`).join(' → ')}`);
  }

  let resultUrl: string | null = null;
  let resultType: string = body.quality;
  let resultSource: string = body.source;
  let resultScriptId = 'share_inline';
  let resultScriptName = body.scriptName || 'Share Script';
  let resultFallback: any = { toggled: false, originalSource };
  const triedScripts: { scriptId: string; scriptName: string; message: string; responseTime: number }[] = [];
  // 换源搜索缓存：一次请求只搜索一次，后续换源复用结果
  let toggleSearchCache: any[] | null = null;

  // ===== 模式1：使用客户端提供的 inline 脚本（支持多脚本 + 换源 + 换脚本） =====
  if (inlineScripts.length > 0) {
    // 根据脚本数量动态分配超时（与 /api/music/url 一致）
    const scriptCount = inlineScripts.length;
    const perScriptTimeout = scriptCount === 1 ? 15000 : scriptCount === 2 ? 7300 : 4300;
    console.log(`[ShareMusicUrl] 模式1: ${scriptCount}个 inline 脚本, 每脚本超时 ${perScriptTimeout}ms, 换源=${allowToggleSource}`);

    for (const scriptInfo of inlineScripts) {
      let runner: ScriptRunner;
      try {
        runner = await getOrCreateRunner(scriptInfo);
      } catch (initErr: any) {
        console.error(`[ShareMusicUrl] 脚本 ${scriptInfo.name} 初始化失败:`, initErr.message);
        triedScripts.push({ scriptId: scriptInfo.id, scriptName: scriptInfo.name, message: '初始化失败: ' + (initErr.message || 'unknown'), responseTime: 0 });
        continue;  // 换下一个脚本（换脚本）
      }

      const startTime = Date.now();
      try {
        const result = await runner.request({
          source: body.source, action: "musicUrl",
          info: { type: body.quality, musicInfo: { id: songId, name: musicInfo?.name || "", singer: musicInfo?.singer || "", source: body.source, songmid: songId, interval: musicInfo?.interval || 0, meta: { songId, hash: musicInfo?.hash || "", copyrightId: musicInfo?.copyrightId || "" }, typeUrl: {}, types: musicInfo?.types || [], _types: {}, hash: musicInfo?.hash || "", copyrightId: musicInfo?.copyrightId || "", strMediaMid: musicInfo?.strMediaMid || "", albumId: musicInfo?.albumId || "", songId: musicInfo?.songId || songId, lrcUrl: "", mrcUrl: "", trcUrl: "" } },
          timeoutMs: perScriptTimeout,
        });
        const responseTime = Date.now() - startTime;

        if (result.data.url) {
          // 黑名单URL检查
          if (result.data.url.endsWith('2149972737147268278.mp3')) {
            console.log(`[ShareMusicUrl] ⚠️ 脚本 ${scriptInfo.name} 返回黑名单URL，触发换源`);
            triedScripts.push({ scriptId: scriptInfo.id, scriptName: scriptInfo.name, message: '黑名单URL', responseTime });

            if (allowToggleSource) {
              if (toggleSearchCache === null) {
                const keyword = `${name} ${singer}`.trim();
                const allSources = ['kw', 'kg', 'tx', 'wy', 'mg'];
                const sourcesToTry = allSources.filter(s => !excludeSources.includes(s));
                toggleSearchCache = await performToggleSearch(keyword, sourcesToTry, name, singer, body, '[ShareToggle]');
                console.log(`[ShareToggle] 首次搜索完成，共 ${toggleSearchCache.length} 个匹配`);
              }
              const toggleResult = await tryToggleSourceForInline(body, songId, name, singer, originalSource, excludeSources, scriptInfo.id, scriptInfo.name, runner, responseTime, toggleSearchCache);
              if (toggleResult.success && toggleResult.url) {
                resultUrl = toggleResult.url;
                resultType = toggleResult.type || body.quality;
                resultSource = toggleResult.newSource || originalSource;
                resultScriptId = scriptInfo.id;
                resultScriptName = scriptInfo.name;
resultFallback = { toggled: true, originalSource, newSource: toggleResult.newSource, matchedSong: toggleResult.matchedSong || { name: toggleResult.matchedName, singer: toggleResult.matchedSinger } };
lyricPromise = getLyricForMatchedSong(toggleResult.matchedSong);
break;
}
}
continue;  // 换下一个脚本
          }

          // 成功获取URL
          resultUrl = result.data.url;
          resultType = result.data.type || body.quality;
          resultSource = body.source;
          resultScriptId = scriptInfo.id;
          resultScriptName = scriptInfo.name;
          break;
        }

        // URL为空，尝试换源
        triedScripts.push({ scriptId: scriptInfo.id, scriptName: scriptInfo.name, message: 'URL为空', responseTime });
        if (allowToggleSource) {
          console.log(`[ShareMusicUrl] 脚本 ${scriptInfo.name} URL为空，触发换源`);
          if (toggleSearchCache === null) {
            const keyword = `${name} ${singer}`.trim();
            const allSources = ['kw', 'kg', 'tx', 'wy', 'mg'];
            const sourcesToTry = allSources.filter(s => !excludeSources.includes(s));
            toggleSearchCache = await performToggleSearch(keyword, sourcesToTry, name, singer, body, '[ShareToggle]');
            console.log(`[ShareToggle] 首次搜索完成，共 ${toggleSearchCache.length} 个匹配`);
          }
          const toggleResult = await tryToggleSourceForInline(body, songId, name, singer, originalSource, excludeSources, scriptInfo.id, scriptInfo.name, runner, responseTime, toggleSearchCache);
          if (toggleResult.success && toggleResult.url) {
            resultUrl = toggleResult.url;
            resultType = toggleResult.type || body.quality;
            resultSource = toggleResult.newSource || originalSource;
            resultScriptId = scriptInfo.id;
            resultScriptName = scriptInfo.name;
resultFallback = { toggled: true, originalSource, newSource: toggleResult.newSource, matchedSong: toggleResult.matchedSong || { name: toggleResult.matchedName, singer: toggleResult.matchedSinger } };
lyricPromise = getLyricForMatchedSong(toggleResult.matchedSong);
break;
}
}
} catch (error: any) {
        const responseTime = Date.now() - startTime;
        triedScripts.push({ scriptId: scriptInfo.id, scriptName: scriptInfo.name, message: error.message || '未知错误', responseTime });
        console.log(`[ShareMusicUrl] ❌ 脚本 ${scriptInfo.name} 失败: ${error.message}, 耗时: ${responseTime}ms`);

        if (allowToggleSource) {
          console.log(`[ShareMusicUrl] 脚本 ${scriptInfo.name} 异常，触发换源`);
          if (toggleSearchCache === null) {
            const keyword = `${name} ${singer}`.trim();
            const allSources = ['kw', 'kg', 'tx', 'wy', 'mg'];
            const sourcesToTry = allSources.filter(s => !excludeSources.includes(s));
            toggleSearchCache = await performToggleSearch(keyword, sourcesToTry, name, singer, body, '[ShareToggle]');
            console.log(`[ShareToggle] 首次搜索完成，共 ${toggleSearchCache.length} 个匹配`);
          }
          const toggleResult = await tryToggleSourceForInline(body, songId, name, singer, originalSource, excludeSources, scriptInfo.id, scriptInfo.name, runner, responseTime, toggleSearchCache);
          if (toggleResult.success && toggleResult.url) {
            resultUrl = toggleResult.url;
            resultType = toggleResult.type || body.quality;
            resultSource = toggleResult.newSource || originalSource;
            resultScriptId = scriptInfo.id;
            resultScriptName = scriptInfo.name;
resultFallback = { toggled: true, originalSource, newSource: toggleResult.newSource, matchedSong: toggleResult.matchedSong || { name: toggleResult.matchedName, singer: toggleResult.matchedSinger } };
lyricPromise = getLyricForMatchedSong(toggleResult.matchedSong);
break;
}
}
}
// 继续下一个脚本（换脚本）
      console.log(`[ShareMusicUrl] → 切换到下一个脚本...`);
    }
  }

  // ===== 模式2：inline 脚本全部失败或未提供 → 使用节点自身脚本 =====
  if (!resultUrl) {
    if (inlineScripts.length > 0) {
      console.log(`[ShareMusicUrl] 所有 ${inlineScripts.length} 个 inline 脚本均失败，降级使用节点脚本...`);
    }
    const storage = new ScriptStorage(env.DB, getStore(env.DB));
    try {
      const allScripts = await storage.getScripts();
      let availableScriptIds: string[] = [];
      for (const s of allScripts) {
        if (s.supportedSources.includes(body.source)) {
          const isTripped = await storage.isScriptCircuitBreakerTripped(s.id);
          if (!isTripped) availableScriptIds.push(s.id);
        }
      }
      if (availableScriptIds.length === 0) {
        for (const s of allScripts) {
          const isTripped = await storage.isScriptCircuitBreakerTripped(s.id);
          if (isTripped) availableScriptIds.push(s.id);
        }
      }

      if (availableScriptIds.length > 0) {
        const sortedIds = await storage.getSortedScriptsBySuccessRate(availableScriptIds, (await storage.getDefaultScript())?.id ?? null);
        const scriptTimeouts = calculateScriptTimeouts(sortedIds, sortedIds.length);

        for (const currentScriptId of sortedIds) {
          const currentScript = allScripts.find(s => s.id === currentScriptId);
          if (!currentScript) continue;
          let rawScript: string | null = null;
          try { rawScript = await storage.getScriptRaw(currentScriptId); } catch (_e) {}
          if (!rawScript) continue;
          const runner = await getOrCreateRunner({ id: currentScriptId, name: currentScript.name, rawScript });
          try {
            const result = await runner.request({ source: body.source, action: "musicUrl", info: { type: body.quality, musicInfo: { id: songId, name: musicInfo?.name || "", singer: musicInfo?.singer || "", source: body.source, songmid: songId, interval: musicInfo?.interval || 0, meta: { songId, hash: musicInfo?.hash || "", copyrightId: musicInfo?.copyrightId || "" }, typeUrl: {}, types: musicInfo?.types || [], _types: {}, hash: musicInfo?.hash || "", copyrightId: musicInfo?.copyrightId || "", strMediaMid: musicInfo?.strMediaMid || "", albumId: musicInfo?.albumId || "", songId: musicInfo?.songId || songId, lrcUrl: "", mrcUrl: "", trcUrl: "" } }, timeoutMs: scriptTimeouts.get(currentScriptId) });
            if (result.data.url) {
              // 黑名单URL检查（与主流程一致）
              if (result.data.url.endsWith('2149972737147268278.mp3')) {
                console.log(`[ShareMusicUrl] ⚠️ 节点脚本 ${currentScript.name} 返回黑名单URL，跳过`);
                await storage.updateScriptStats(currentScriptId, false, 0);
                await storage.recordScriptFailure(currentScriptId);
                continue;
              }
              resultUrl = result.data.url;
              resultType = result.data.type || body.quality;
              resultSource = body.source;
              resultScriptId = currentScriptId;
              resultScriptName = currentScript.name;
              await storage.updateScriptStats(currentScriptId, true, 0);
              await storage.recordScriptSuccess(currentScriptId);
              break;
            }
          } catch (e: any) {
            await storage.updateScriptStats(currentScriptId, false, 0);
            await storage.recordScriptFailure(currentScriptId);
          }
        }
        await storage.flush();
      }
    } catch (e: any) {
      console.error("[ShareMusicUrl] 节点脚本执行异常:", e.message);
    }
  }

  if (resultUrl) {
    const newCount = await incrementShareUsage(env?.DB);
    // 等待歌词结果（最多2秒）
    const lyricResult = await Promise.race([lyricPromise, new Promise<any>(r => setTimeout(() => r({ lyric: '', tlyric: '', rlyric: '', lxlyric: '' }), 2000))]);
    return jsonResponse({
      url: resultUrl,
      type: resultType,
      source: resultSource,
      quality: body.quality,
      lyric: lyricResult.lyric || '',
      tlyric: lyricResult.tlyric || '',
      rlyric: lyricResult.rlyric || '',
      lxlyric: lyricResult.lxlyric || '',
      cached: false,
      fallback: resultFallback,
      scriptId: resultScriptId,
      scriptName: resultScriptName,
      triedScripts: triedScripts.length > 0 ? triedScripts : undefined,
      share_info: {
        daily_limit: config.daily_limit,
        current_usage: newCount,
        remaining: Math.max(0, config.daily_limit - newCount),
        reserved_limit: config.reserved_limit,
        contributor_name: config.contributor_name,
      },
    });
  }
  return jsonResponse(null, 500, "get music url failed", { triedScripts: triedScripts.length > 0 ? triedScripts : undefined });
  } catch (outerError: any) {
    console.error("[ShareMusicUrl] Unhandled error:", outerError?.message || String(outerError));
    return jsonResponse(null, 500, "share music url error: " + (outerError?.message || "unknown"));
  }
}

async function handleSetShareConfig(request: Request, env: Env): Promise<Response> {
  // 鉴权通过路径 /owner/{apiKey}/share/config 完成，无需 Header
  const body = await request.json() as any;
  const oldConfig = await getShareConfig(env.DB);
  const config: ShareConfig = { ...oldConfig };
  if (body.status !== undefined) {
    const newStatus = parseInt(body.status) === 1 ? 1 : (parseInt(body.status) === 2 ? 2 : 0);
    // 每次开启分享(status→1)时重新生成 node_id
    if (newStatus === 1 && config.status !== 1) {
      config.node_id = "phg-" + crypto.randomUUID();
      if (!config.shared_since) config.shared_since = Date.now();
    }
    config.status = newStatus;
  }
  if (body.daily_limit !== undefined) config.daily_limit = parseInt(body.daily_limit) || 50000;
  if (body.reserved_limit !== undefined) config.reserved_limit = parseInt(body.reserved_limit) || 20000;
  if (body.contributor_name !== undefined) config.contributor_name = String(body.contributor_name).slice(0, 50);
  await setShareConfig(env.DB, config);
  return jsonResponse({ success: true, config });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 每个请求开始时清除 AppDataStore 缓存，确保跨 isolate 读到最新 DB 数据
    if (_appDataStore) _appDataStore.invalidateCache();

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });

    const apiKey = env.API_KEY || '';
    const storage = new ScriptStorage(env.DB, getStore(env.DB));
    const pathParts = url.pathname.split('/').filter(Boolean);
    const apiKeyInPath = pathParts[0];

    // ===== Share Plan Routes =====
    try {
    // Owner 路由：/owner/{apiKey}/status, /owner/{apiKey}/share/config
    if (pathParts[0] === "owner" && pathParts.length >= 3) {
      const ownerKey = pathParts[1];
      const subPath = pathParts[2];
      if (ownerKey !== apiKey) return jsonResponse(null, 403, "invalid owner key");
      if (subPath === "status" && request.method === "GET") return await handleOwnerStatus(request, env);
      if (subPath === "share" && pathParts[3] === "config") {
        if (request.method === "POST") return await handleSetShareConfig(request, env);
      }
    }
    // Public 路由：/{publicKey}/status, /{publicKey}/share/music-url, /{publicKey}/share/config (mesh registry only sets status)
    if (env.PUBLIC_KEY && pathParts[0] === env.PUBLIC_KEY) {
      if (pathParts.length >= 2 && pathParts[1] === "status" && request.method === "GET") return await handleShareStatus(request, env);
      if (pathParts.length >= 3 && pathParts[1] === "share" && pathParts[2] === "music-url" && request.method === "POST") {
        ctx.waitUntil(incrementCounters(env.DB, false));
        return await withTimeout(handleShareMusicUrl(request, env), REQUEST_TIMEOUT_MS);
      }
      // Mesh registry 踢下线：/{publicKey}/share/config POST，只允许设置 status
      if (pathParts.length >= 3 && pathParts[1] === "share" && pathParts[2] === "config" && request.method === "POST") {
        const body = await request.json() as any;
        if (body.status !== undefined) {
          // 只允许 mesh registry 设置 status=2（踢下线），不能设置其他值
          if (parseInt(body.status) === 2) {
            const oldConfig = await getShareConfig(env.DB);
            const config: ShareConfig = { ...oldConfig, status: 2 };
            await setShareConfig(env.DB, config);
            return jsonResponse({ success: true, message: "status set to 2 (kicked offline)" });
          }
        }
        return jsonResponse(null, 400, "invalid request");
      }
      // 公共歌单详情：/{publicKey}/share/songlist-detail POST（供免费模式客户端获取QQ音乐歌单）
      if (pathParts.length >= 3 && pathParts[1] === "share" && pathParts[2] === "songlist-detail" && request.method === "POST") {
        const appData = await getAppData(env.DB);
        const config = appData.share_config;
        if (config.status !== 1) return jsonResponse(null, 403, "share mode is disabled");
        const today = getTodayDateString();
        const usageCount = appData.usage.daily[today]?.share || 0;
        if (usageCount >= config.daily_limit) return jsonResponse(null, 429, "daily share limit reached");
        ctx.waitUntil(incrementCounters(env.DB, false));
        return await withTimeout(handleGetSongListDetailByLink(request), REQUEST_TIMEOUT_MS);
      }
    }

    // apiKey 路由：/{apiKey}/status（供客户端测试连通性和版本检查）
    if (apiKeyInPath === apiKey && pathParts.length >= 2 && pathParts[1] === "status" && request.method === "GET") {
      return await handleOwnerStatus(request, env);
    }
    } catch (error: any) {
      return jsonResponse(null, 500, error.message || 'Internal Server Error');
    }
    
    const isApiCall = pathParts.length >= 2 && (pathParts[1] === 'api' || pathParts[1] === 'scripts');
    if (isApiCall && apiKeyInPath !== apiKey) return jsonResponse(null, 401, '无效的 API Key');

    const pathEndsWith = (suffix: string) => url.pathname.endsWith(suffix);

    if (pathEndsWith('/setup')) {
      return jsonResponse({ apiKey, endpoints: {
        importScript: `POST /${apiKey}/api/scripts/import/url`,
        getMusicUrl: `POST /${apiKey}/api/music/url`,
        loadedScripts: `GET /${apiKey}/api/scripts/loaded`,
        search: `GET /${apiKey}/api/search?keyword=xxx&source=kw&page=1&limit=20`,
        songListDetail: `POST /${apiKey}/api/songlist/detail`,
        songListByLink: `POST /${apiKey}/api/songlist/detail/by-link`,
        aiChat: `POST /${apiKey}/api/ai/chat`,
        aiModels: `GET /${apiKey}/api/ai/models`,
      }});
    }

    try {
      switch (`${request.method} ${url.pathname}`) {
        case `GET /health`:
          return jsonResponse({ code: 200, msg: 'success', data: { status: 'ok', service: 'cf-phg-music-server' } });

        case `POST /${apiKey}/api/scripts/import/url`:
          return await withTimeout(handleImportScriptFromUrl(request, storage), REQUEST_TIMEOUT_MS);

        case `POST /${apiKey}/api/scripts/import/raw`:
          return await withTimeout(handleImportScriptRaw(request, storage), REQUEST_TIMEOUT_MS);

case `POST /${apiKey}/api/music/url`:
ctx.waitUntil(incrementCounters(env.DB, false));
return await withTimeout(handleGetMusicUrl(request, storage, env), REQUEST_TIMEOUT_MS);

        case `POST /${apiKey}/api/music/lyric`:
          ctx.waitUntil(incrementCounters(env.DB, false));
          return await withTimeout(handleGetLyric(request), REQUEST_TIMEOUT_MS);

        case `GET /${apiKey}/api/scripts/loaded`:
          return await withTimeout(handleGetLoadedScripts(request, storage), REQUEST_TIMEOUT_MS);

        case `POST /${apiKey}/api/scripts/default`:
          return await withTimeout(handleSetDefaultScript(request, storage), REQUEST_TIMEOUT_MS);

        case `GET /${apiKey}/api/scripts/default`:
          return await withTimeout(handleGetDefaultScript(storage), REQUEST_TIMEOUT_MS);

        case `POST /${apiKey}/api/scripts/delete`:
          return await withTimeout(handleDeleteScript(request, storage), REQUEST_TIMEOUT_MS);

        case `GET /${apiKey}/api/search`: case `GET /${apiKey}/api/search/`:
          ctx.waitUntil(incrementCounters(env.DB, false));
          return await withTimeout(handleSearch(request), REQUEST_TIMEOUT_MS);

        case `POST /${apiKey}/api/songlist/detail`:
          ctx.waitUntil(incrementCounters(env.DB, false));
          return await withTimeout(handleGetSongListDetail(request), REQUEST_TIMEOUT_MS);

        case `POST /${apiKey}/api/songlist/detail/by-link`:
          ctx.waitUntil(incrementCounters(env.DB, false));
          return await withTimeout(handleGetSongListDetailByLink(request, storage), REQUEST_TIMEOUT_MS);

        case `POST /${apiKey}/api/ai/chat`:
          return await withTimeout(handleAIChat(request, env), REQUEST_TIMEOUT_MS);

        case `GET /${apiKey}/api/ai/models`: case `GET /${apiKey}/api/ai/models/`:
          return await withTimeout(handleGetAIModels(), REQUEST_TIMEOUT_MS);

        case `GET /${apiKey}`:
          return jsonResponse({ status: 'ok', version: '1.0.0', endpoints: [
            'POST /{key}/api/scripts/import/url - 导入脚本',
            'POST /{key}/api/music/url - 获取音乐URL',
            'GET /{key}/api/scripts/loaded - 已加载脚本列表',
            'POST /{key}/api/scripts/default - 设置默认脚本',
            'GET /{key}/api/scripts/default - 获取默认脚本',
            'POST /{key}/api/scripts/delete - 删除脚本',
            'GET /{key}/api/search?keyword=xxx - 搜索歌曲',
            'POST /{key}/api/songlist/detail - 歌单详情',
            'POST /{key}/api/songlist/detail/by-link - 链接解析歌单',
          ]});

        default:
          if (url.pathname === '/' || url.pathname === '/health') return jsonResponse({ status: 'ok', service: 'cf-phg-music-server' });
          if (url.pathname === '/debug/fetch-test') {
            const testUrl = url.searchParams.get('url') || 'https://88.lxmusic.xn--fiqs8s/lxmusicv4/url/tx/000mNo691TTyRP/128k?sign=3d70d2d3dfde12d07c892b458cb768e8ee94418966c96654f66c9cad6e269814';
            try {
              const resp = await fetch(testUrl, { headers: { 'Content-Type': 'application/json', 'User-Agent': 'lx-music-desktop/2.0.0', 'X-Request-Key': 'lxmusic' } });
              const body = await resp.text();
              return jsonResponse({ status: resp.status, statusText: resp.statusText, bodyPreview: body.substring(0, 500) });
            } catch (e: any) {
              return jsonResponse({ error: e.message });
            }
          }
          return jsonResponse(null, 404, 'Not Found');
      }
    } catch (error: any) { return jsonResponse(null, 500, error.message || 'Internal Server Error'); }
    finally { await storage.flush(); }
  },
};

function corsHeaders(): Record<string, string> {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('请求超时 (' + ms + 'ms)')), ms);
  });
  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutId!);
    return result as T;
  } catch (error: any) {
    clearTimeout(timeoutId!);
    throw error;
  }
}
