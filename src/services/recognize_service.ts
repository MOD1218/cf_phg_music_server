/**
 * 听歌识曲服务
 * 从 CeruMusic 的 recognize.js + recognize.vue 移植
 *
 * 完整流程:
 * 1. 接收 WAV 音频文件
 * 2. 解码为 8kHz 单声道 PCM
 * 3. 用 WASM (afp) 生成 Shazam v2 指纹
 * 4. 调用网易云音乐识曲 API
 * 5. 获取歌曲详情 (音质/封面)
 * 6. 返回结构化结果
 */

import { GenerateFP } from '../afp_runtime.js';
import { decodeAudioToPcm, getAudioFormat, wrapRawPcmAsWav } from '../utils/audio_decode.ts';

// ==================== 类型定义 ====================

export interface RecognizedSong {
  songmid: string;
  name: string;
  singer: string;
  albumName: string;
  albumId: number;
  source: string;
  interval: string;
  img: string;
  startTime: number;
  types: Array<{ type: string; size: string }>;
  _types: Record<string, { size: string }>;
}

// ==================== 工具函数 ====================

function formatPlayTime(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '00:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function sizeFormate(bytes: number): string {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + 'KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + 'MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + 'GB';
}

function formatSingerName(artists: any[], key: string = 'name'): string {
  if (!artists || artists.length === 0) return '';
  return artists.map(a => a[key] || '').join(' / ');
}

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// ==================== 核心: 指纹生成 ====================

/**
 * 用 WASM 模块从 PCM 数据生成 Shazam v2 指纹
 * 对应 CeruMusic afp.js 的 GenerateFP 函数
 */
async function generateFingerprint(pcm: Float32Array): Promise<string> {
  console.log('[RecognizeService] Generating fingerprint, PCM samples:', pcm.length);
  const fp = await GenerateFP(pcm);
  console.log('[RecognizeService] Fingerprint generated, length:', fp.length);
  return fp;
}

/**
 * 网易云 Shazam v2 API 只接受 ~3 秒的音频指纹
 * 长于 3 秒的指纹会返回 noMatchReason=10 (无匹配)
 * CeruMusic 原版使用 SLICE_DURATION = 3000 (3秒切片)
 *
 * 此函数将 PCM 切成 3 秒段落 (带 1 秒滑动重叠)，逐段尝试识别
 */
const SLICE_DURATION_SEC = 3;  // 每段 3 秒
const SLIDE_STEP_SEC = 1;      // 滑动步长 1 秒
const MAX_DURATION_SEC = 15;   // 最大处理 15 秒

async function recognizeBySlices(pcm: Float32Array): Promise<any[]> {
  const totalSamples = Math.min(pcm.length, MAX_DURATION_SEC * 8000);
  const sliceSamples = SLICE_DURATION_SEC * 8000;
  const stepSamples = SLIDE_STEP_SEC * 8000;

  if (totalSamples < sliceSamples) {
    // 音频不足 3 秒，直接用全部数据
    console.log('[RecognizeService] Audio too short for slicing, using entire audio');
    try {
      const fp = await generateFingerprint(pcm.subarray(0, totalSamples));
      const results = await callNeteaseRecognize(fp, totalSamples / 8000);
      if (results.length > 0) return results;
    } catch (e: any) {
      console.error('[RecognizeService] Short audio recognition failed:', e.message);
    }
    return [];
  }

  // 逐段尝试识别（单个切片失败不影响后续切片尝试）
  const maxStartIdx = totalSamples - sliceSamples;
  for (let startIdx = 0; startIdx <= maxStartIdx; startIdx += stepSamples) {
    const endIdx = startIdx + sliceSamples;
    const slice = pcm.subarray(startIdx, endIdx);
    const startTime = startIdx / 8000;
    const endTime = endIdx / 8000;
    console.log(`[RecognizeService] Trying slice: ${startTime.toFixed(1)}s - ${endTime.toFixed(1)}s (${slice.length} samples)`);

    try {
      const fp = await generateFingerprint(slice);
      const results = await callNeteaseRecognize(fp, SLICE_DURATION_SEC);

      if (results.length > 0) {
        console.log(`[RecognizeService] ✅ Match found in slice ${startTime.toFixed(1)}s - ${endTime.toFixed(1)}s!`);
        return results;
      }

      console.log(`[RecognizeService] ❌ No match in slice ${startTime.toFixed(1)}s - ${endTime.toFixed(1)}s`);
    } catch (e: any) {
      // 单个切片失败（WASM 冷启动、API 返回非 JSON、网络抖动等）不影响后续切片
      console.error(`[RecognizeService] ⚠️ Slice ${startTime.toFixed(1)}s-${endTime.toFixed(1)}s failed:`, e.message);
      continue;
    }
  }

  console.log('[RecognizeService] No match found in any slice');
  return [];
}

// ==================== 核心: 网易云识曲 API ====================

/**
 * 调用网易云音乐识曲接口
 * 完全照抄 CeruMusic recognize.js 的逻辑
 *
 * POST https://interface.music.163.com/api/music/audio/match
 * params: algorithmCode=shazam_v2, rawdata=指纹, duration=时长
 */
async function callNeteaseRecognize(fp: string, duration: number): Promise<any[]> {
  const params = new URLSearchParams({
    sessionId: generateUUID(),
    algorithmCode: 'shazam_v2',
    duration: String(Math.floor(duration)),
    rawdata: fp,
    times: '1',
    decrypt: '1',
  });

  const url = `https://interface.music.163.com/api/music/audio/match?${params.toString()}`;
  console.log('[RecognizeService] Calling NetEase API, duration:', duration);

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36',
      'Origin': 'https://music.163.com',
    },
  });

  // 容错：网易云可能返回非 JSON 格式（如限流 HTML 页面、空响应）
  if (!resp.ok) {
    console.log('[RecognizeService] NetEase API returned HTTP', resp.status);
    return [];
  }

  let body: any;
  try {
    body = await resp.json() as any;
  } catch (e: any) {
    console.log('[RecognizeService] NetEase API returned non-JSON response:', e.message);
    return [];
  }

  if (body.data && body.data.result && body.data.result.length > 0) {
    console.log('[RecognizeService] NetEase returned', body.data.result.length, 'results');
    return body.data.result;
  }

  console.log('[RecognizeService] No results from NetEase');
  return [];
}

// ==================== 核心: 获取歌曲详情 ====================

/**
 * 获取歌曲音质信息
 * 照抄 CeruMusic recognize.js 中获取 detail 的逻辑
 *
 * GET https://music.163.com/api/song/music/detail/get?songId=xxx
 */
async function getSongDetail(songId: string): Promise<any> {
  const url = `https://music.163.com/api/song/music/detail/get?songId=${songId}`;

  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36',
      'Origin': 'https://music.163.com',
    },
  });

  if (!resp.ok) {
    throw new Error(`Failed to get song detail: ${resp.status}`);
  }

  const body = await resp.json() as any;

  if (!body || body.code !== 200) {
    throw new Error('Failed to get song quality information');
  }

  return body.data;
}

/**
 * 解析音质信息
 * 照抄 CeruMusic recognize.js 中 types 解析逻辑
 */
function parseQualityTypes(data: any): { types: any[]; _types: Record<string, { size: string }> } {
  const types: any[] = [];
  const _types: Record<string, { size: string }> = {};
  let size: string;

  if (data.jm && data.jm.size) {
    size = sizeFormate(data.jm.size);
    types.push({ type: 'master', size });
    _types.master = { size };
  }
  if (data.db && data.db.size) {
    size = sizeFormate(data.db.size);
    types.push({ type: 'dolby', size });
    _types.dolby = { size };
  }
  if (data.hr && data.hr.size) {
    size = sizeFormate(data.hr.size);
    types.push({ type: 'hires', size });
    _types.hires = { size };
  }
  if (data.sq && data.sq.size) {
    size = sizeFormate(data.sq.size);
    types.push({ type: 'flac', size });
    _types.flac = { size };
  }
  if (data.h && data.h.size) {
    size = sizeFormate(data.h.size);
    types.push({ type: '320k', size });
    _types['320k'] = { size };
  }
  if (data.m && data.m.size) {
    size = sizeFormate(data.m.size);
    types.push({ type: '128k', size });
    _types['128k'] = { size };
  } else if (data.l && data.l.size) {
    size = sizeFormate(data.l.size);
    types.push({ type: '128k', size });
    _types['128k'] = { size };
  }

  types.reverse();
  return { types, _types };
}

// ==================== 主服务入口 ====================

/**
 * 听歌识曲主流程
 *
 * @param audioBuffer 音频文件的 ArrayBuffer (WAV 格式)
 * @returns 识别到的歌曲列表
 */
export async function recognizeAudio(audioBuffer: ArrayBuffer): Promise<RecognizedSong[]> {
  console.log('[RecognizeService] Starting recognition, buffer size:', audioBuffer.byteLength);

  // 1. 检查音频格式
  const format = getAudioFormat(audioBuffer);
  let workBuffer = audioBuffer;

  if (format === 'wav') {
    console.log('[RecognizeService] Audio format: WAV');
  } else if (format === 'unknown') {
    // 非 WAV/MP3 格式：尝试将数据视为 raw PCM，包装为 WAV 后处理
    // 微信开发者工具的录音不是真正的 WAV，但原始数据可能是 PCM
    console.log('[RecognizeService] Audio format: unknown, attempting raw PCM fallback');
    try {
      workBuffer = wrapRawPcmAsWav(audioBuffer, 44100, 1, 16);
      console.log('[RecognizeService] Raw PCM wrapped as WAV, size:', workBuffer.byteLength);
    } catch (e: any) {
      throw new Error(`Cannot process audio data: ${e.message}`);
    }
  } else {
    throw new Error(`Unsupported audio format: ${format}. Only WAV is supported.`);
  }

  // 2. 解码音频 → 8kHz 单声道 PCM
  const { pcm, duration } = decodeAudioToPcm(workBuffer);
  console.log('[RecognizeService] PCM decoded, samples:', pcm.length, 'duration:', duration);

  // 3. 切成 3 秒段落，逐段生成指纹并调用网易云识曲 API
  // (网易云 Shazam v2 API 只接受 ~3 秒的指纹，更长的会返回无匹配)
  const neteaseResults = await recognizeBySlices(pcm);

  if (neteaseResults.length === 0) {
    return [];
  }

  // 5. 获取每首歌的详情并格式化结果
  const tasks = neteaseResults.map(async (item: any): Promise<RecognizedSong | null> => {
    const rawSong = item.song;
    if (!rawSong) return null;

    const artists = rawSong.artist || rawSong.artists || [];
    const artistName = formatSingerName(artists, 'name');
    const album = rawSong.album || {};
    const startTime = item.startTime || 0;

    try {
      const detailData = await getSongDetail(rawSong.id);
      const { types, _types } = parseQualityTypes(detailData);

      return {
        songmid: String(rawSong.id),
        name: rawSong.name,
        singer: artistName,
        albumName: album.name || '',
        albumId: album.id || 0,
        source: 'wy',
        interval: formatPlayTime(rawSong.duration / 1000),
        img: album.picUrl || album.blurPicUrl || '',
        startTime,
        types,
        _types,
      };
    } catch (error: any) {
      console.error('[RecognizeService] Failed to get detail for song', rawSong.id, ':', error.message);
      // 即使获取详情失败，也返回基本信息
      return {
        songmid: String(rawSong.id),
        name: rawSong.name,
        singer: artistName,
        albumName: album.name || '',
        albumId: album.id || 0,
        source: 'wy',
        interval: formatPlayTime(rawSong.duration / 1000),
        img: album.picUrl || album.blurPicUrl || '',
        startTime,
        types: [],
        _types: {},
      };
    }
  });

  const results = (await Promise.all(tasks)).filter((item): item is RecognizedSong => item !== null);
  console.log('[RecognizeService] Recognition complete, results:', results.length);
  return results;
}
