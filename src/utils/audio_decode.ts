/**
 * 音频解码工具
 * 从 CeruMusic 的 resampleTo8kMono 逻辑移植
 * 支持 WAV 格式解析 + 重采样到 8kHz 单声道
 */

const TARGET_SAMPLE_RATE = 8000;

/**
 * WAV 文件头解析结果
 */
interface WavInfo {
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataSize: number;
}

/**
 * 解析 WAV 文件头
 * WAV 格式: RIFF header + fmt chunk + data chunk
 * 
 * 注意：某些 WAV 写入器（如微信小程序录音）可能会：
 * 1. 将 dataSize 设置为 0（流式写入，未回填大小）
 * 2. 将 dataSize 设置为比实际数据更大的值
 * 因此必须对 dataSize 做边界裁剪
 */
function parseWavHeader(buffer: ArrayBuffer): WavInfo {
  const view = new DataView(buffer);

  // 检查 RIFF 标识
  if (view.getUint32(0, false) !== 0x52494646) { // 'RIFF'
    throw new Error('Not a valid WAV file: missing RIFF header');
  }
  // 检查 WAVE 标识
  if (view.getUint32(8, false) !== 0x57415645) { // 'WAVE'
    throw new Error('Not a valid WAV file: missing WAVE header');
  }

  let offset = 12;
  let sampleRate = 0;
  let numChannels = 0;
  let bitsPerSample = 0;
  let dataOffset = 0;
  let dataSize = 0;

  while (offset < buffer.byteLength - 8) {
    // 防御性检查：确保读取 chunk header 不越界
    if (offset + 8 > buffer.byteLength) break;

    const chunkId = view.getUint32(offset, false);
    const chunkSize = view.getUint32(offset + 4, true);

    if (chunkId === 0x666d7420) { // 'fmt '
      // 防御性检查：确保读取 fmt 字段不越界
      if (offset + 24 <= buffer.byteLength) {
        numChannels = view.getUint16(offset + 10, true);
        sampleRate = view.getUint32(offset + 12, true);
        bitsPerSample = view.getUint16(offset + 22, true);
      }
    } else if (chunkId === 0x64617461) { // 'data'
      dataOffset = offset + 8;
      dataSize = chunkSize;
      break;
    }

    // 防止 chunkSize 过大导致溢出
    if (chunkSize > buffer.byteLength) {
      // chunkSize 异常大，跳过此 chunk
      break;
    }
    offset += 8 + chunkSize;
    // chunks are word-aligned
    if (chunkSize % 2 !== 0) offset += 1;
  }

  if (sampleRate === 0 || dataOffset === 0) {
    throw new Error('Invalid WAV: missing fmt or data chunk');
  }

  // ★ 关键修复：clamp dataSize 到实际可用字节数
  // 某些 WAV 写入器（如微信小程序）的 dataSize 可能：
  // - 为 0（流式写入未回填）
  // - 大于实际文件中可用的数据（header 声称的大小 > 文件实际大小）
  const availableData = buffer.byteLength - dataOffset;
  if (dataSize === 0 || dataSize > availableData) {
    console.log(`[AudioDecode] dataSize adjusted: header=${dataSize}, available=${availableData}, using=${Math.min(dataSize || availableData, availableData)}`);
    dataSize = availableData;
  }

  console.log(`[AudioDecode] WAV header: sampleRate=${sampleRate}, channels=${numChannels}, bits=${bitsPerSample}, dataOffset=${dataOffset}, dataSize=${dataSize}, fileSize=${buffer.byteLength}`);

  return { sampleRate, numChannels, bitsPerSample, dataOffset, dataSize };
}

/**
 * 将 WAV ArrayBuffer 解码为 Float32Array PCM
 * 参考 CeruMusic: AudioContext.decodeAudioData → getChannelData(0)
 */
function wavToPcm(buffer: ArrayBuffer): { pcm: Float32Array; sampleRate: number; channels: number } {
  const info = parseWavHeader(buffer);
  const view = new DataView(buffer);

  // 防御性检查：防止除零
  const bytesPerSample = info.bitsPerSample / 8;
  if (bytesPerSample === 0 || info.numChannels === 0) {
    throw new Error(`Invalid WAV params: bitsPerSample=${info.bitsPerSample}, numChannels=${info.numChannels}`);
  }

  // 使用 clamp 后的 dataSize 计算样本数
  const numSamples = Math.floor(info.dataSize / bytesPerSample / info.numChannels);
  const pcm = new Float32Array(numSamples);

  // 计算最后一个样本的结束偏移，用于边界检查
  const maxOffset = buffer.byteLength;

  if (info.bitsPerSample === 16) {
    for (let i = 0; i < numSamples; i++) {
      let sum = 0;
      for (let ch = 0; ch < info.numChannels; ch++) {
        const offset = info.dataOffset + (i * info.numChannels + ch) * 2;
        // 边界检查：防止 DataView 越界
        if (offset + 2 > maxOffset) {
          // 数据不足，截断
          return { pcm: pcm.subarray(0, i), sampleRate: info.sampleRate, channels: info.numChannels };
        }
        const sample = view.getInt16(offset, true);
        sum += sample;
      }
      // 归一化到 -1.0 ~ 1.0，多声道取平均
      pcm[i] = sum / info.numChannels / 32768;
    }
  } else if (info.bitsPerSample === 8) {
    for (let i = 0; i < numSamples; i++) {
      let sum = 0;
      for (let ch = 0; ch < info.numChannels; ch++) {
        const offset = info.dataOffset + i * info.numChannels + ch;
        if (offset + 1 > maxOffset) {
          return { pcm: pcm.subarray(0, i), sampleRate: info.sampleRate, channels: info.numChannels };
        }
        const sample = view.getUint8(offset) - 128;
        sum += sample;
      }
      pcm[i] = sum / info.numChannels / 128;
    }
  } else if (info.bitsPerSample === 32) {
    for (let i = 0; i < numSamples; i++) {
      let sum = 0;
      for (let ch = 0; ch < info.numChannels; ch++) {
        const offset = info.dataOffset + (i * info.numChannels + ch) * 4;
        if (offset + 4 > maxOffset) {
          return { pcm: pcm.subarray(0, i), sampleRate: info.sampleRate, channels: info.numChannels };
        }
        const sample = view.getFloat32(offset, true);
        sum += sample;
      }
      pcm[i] = sum / info.numChannels;
    }
  } else {
    throw new Error(`Unsupported bitsPerSample: ${info.bitsPerSample}`);
  }

  return { pcm, sampleRate: info.sampleRate, channels: info.numChannels };
}

/**
 * 重采样到 8kHz 单声道
 * 参考 CeruMusic: OfflineAudioContext(1, duration*8000, 8000)
 * 使用线性插值实现
 */
function resampleTo8kMono(pcm: Float32Array, sourceSampleRate: number): Float32Array {
  if (sourceSampleRate === TARGET_SAMPLE_RATE) {
    return pcm;
  }

  const ratio = sourceSampleRate / TARGET_SAMPLE_RATE;
  const targetLength = Math.floor(pcm.length / ratio);
  const result = new Float32Array(targetLength);

  for (let i = 0; i < targetLength; i++) {
    const srcIndex = i * ratio;
    const srcIndexFloor = Math.floor(srcIndex);
    const srcIndexCeil = Math.min(srcIndexFloor + 1, pcm.length - 1);
    const fraction = srcIndex - srcIndexFloor;
    // 线性插值
    result[i] = pcm[srcIndexFloor] * (1 - fraction) + pcm[srcIndexCeil] * fraction;
  }

  return result;
}

/**
 * 截取前 N 秒的音频
 * 参考 CeruMusic: MAX_DURATION = 15, targetLength = 15 * 8000
 */
function trimToMaxDuration(pcm: Float32Array, maxSeconds: number = 15): Float32Array {
  const maxSamples = maxSeconds * TARGET_SAMPLE_RATE;
  if (pcm.length <= maxSamples) {
    return pcm;
  }
  return pcm.subarray(0, maxSamples);
}

/**
 * 基本静音检测
 * 参考 CeruMusic: tryRecognize 中的 silence check
 */
function checkSilence(pcm: Float32Array): boolean {
  let hasSound = false;
  for (let i = 0; i < pcm.length; i += 100) {
    if (Math.abs(pcm[i]) > 0.01) {
      hasSound = true;
      break;
    }
  }
  return hasSound;
}

/**
 * 完整的音频预处理流程
 * 输入: WAV ArrayBuffer
 * 输出: 8kHz 单声道 Float32Array PCM (最多15秒)
 */
export function decodeAudioToPcm(buffer: ArrayBuffer): { pcm: Float32Array; duration: number } {
  const { pcm, sampleRate } = wavToPcm(buffer);
  const pcm8k = resampleTo8kMono(pcm, sampleRate);
  const trimmed = trimToMaxDuration(pcm8k, 15);

  if (!checkSilence(trimmed)) {
    throw new Error('Audio is silent, cannot generate fingerprint');
  }

  const duration = trimmed.length / TARGET_SAMPLE_RATE;
  return { pcm: trimmed, duration };
}

/**
 * 获取音频文件的 MIME 类型
 */
export function getAudioFormat(buffer: ArrayBuffer): 'wav' | 'mp3' | 'unknown' {
  const view = new DataView(buffer);
  if (buffer.byteLength < 4) return 'unknown';

  // WAV: RIFF
  if (view.getUint32(0, false) === 0x52494646) {
    return 'wav';
  }

  // MP3: ID3 tag or frame sync
  const header = view.getUint32(0, false);
  if (header === 0x49443303 || // 'ID3' + version 03
      header === 0x49443302 || // 'ID3' + version 02
      header === 0x49443304 || // 'ID3' + version 04
      (view.getUint16(0, false) & 0xFFE0) === 0xFFE0) { // Frame sync
    return 'mp3';
  }

  return 'unknown';
}

/**
 * 将 raw PCM 数据包装为 WAV 格式
 * 用于处理没有 RIFF 头的裸 PCM 数据（如微信开发者工具的录音）
 * @param buffer 原始音频数据
 * @param sampleRate 采样率（默认 44100，与客户端录音设置一致）
 * @param numChannels 声道数（默认 1）
 * @param bitsPerSample 位深（默认 16）
 * @returns WAV 格式的 ArrayBuffer
 */
export function wrapRawPcmAsWav(
  buffer: ArrayBuffer,
  sampleRate: number = 44100,
  numChannels: number = 1,
  bitsPerSample: number = 16
): ArrayBuffer {
  const pcmData = new Uint8Array(buffer);
  const dataSize = pcmData.length;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;

  const wavBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(wavBuffer);

  // RIFF header
  writeStrToView(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStrToView(view, 8, 'WAVE');

  // fmt chunk
  writeStrToView(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data chunk
  writeStrToView(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // 写入 PCM 数据
  const dst = new Uint8Array(wavBuffer, 44);
  dst.set(pcmData);

  return wavBuffer;
}

function writeStrToView(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
