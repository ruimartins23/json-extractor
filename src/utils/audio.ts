import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { Mp3Encoder } from '@breezystack/lamejs';

export type AudioFormat = 'm4a' | 'mp3';

/** Decode any media file the browser can read (mp4, m4a, mp3, wav…) into PCM. */
export async function decodeAudioFile(file: File): Promise<AudioBuffer> {
  const bytes = await file.arrayBuffer();
  const ctx = new AudioContext();
  try {
    return await ctx.decodeAudioData(bytes);
  } finally {
    ctx.close();
  }
}

/**
 * Peak envelope for drawing a waveform, one value per bucket, taken across every
 * channel: a stereo call can carry one speaker per side, and both must show.
 */
export function waveformPeaks(buffer: AudioBuffer, buckets: number): number[] {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const length = channels[0]?.length ?? 0;
  const per = Math.max(1, Math.floor(length / buckets));
  const peaks: number[] = [];
  for (let i = 0; i < buckets; i++) {
    const start = i * per;
    let peak = 0;
    for (const channel of channels) {
      for (let j = start; j < start + per && j < length; j++) {
        const v = Math.abs(channel[j]);
        if (v > peak) peak = v;
      }
    }
    peaks.push(peak);
  }
  return peaks;
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

/**
 * Encode a slice of an AudioBuffer to .m4a (AAC in an MP4 container) using the
 * browser's native encoder, so no transcoding library is needed.
 */
export async function encodeToM4A(
  buffer: AudioBuffer,
  startSec: number,
  endSec: number,
  onProgress?: (fraction: number) => void,
): Promise<Blob> {
  const sampleRate = buffer.sampleRate;
  const channels = Math.min(2, buffer.numberOfChannels);
  const startFrame = Math.max(0, Math.floor(startSec * sampleRate));
  const endFrame = Math.min(buffer.length, Math.ceil(endSec * sampleRate));
  const total = endFrame - startFrame;
  if (total <= 0) throw new Error('The selected range is empty.');

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    audio: { codec: 'aac', numberOfChannels: channels, sampleRate },
    fastStart: 'in-memory',
  });

  let encoderError: Error | null = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => { encoderError = e instanceof Error ? e : new Error(String(e)); },
  });
  encoder.configure({ codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels, bitrate: 128000 });

  // Feed the PCM in planar chunks; AudioData wants all of one channel, then the next.
  const CHUNK = 8192;
  const source = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));

  for (let offset = 0; offset < total; offset += CHUNK) {
    if (encoderError) throw encoderError;
    const frames = Math.min(CHUNK, total - offset);
    const planar = new Float32Array(frames * channels);
    for (let c = 0; c < channels; c++) {
      planar.set(source[c].subarray(startFrame + offset, startFrame + offset + frames), c * frames);
    }
    const data = new AudioData({
      format: 'f32-planar',
      sampleRate,
      numberOfFrames: frames,
      numberOfChannels: channels,
      timestamp: Math.round((offset / sampleRate) * 1_000_000),
      data: planar,
    });
    encoder.encode(data);
    data.close();

    // Let the encoder drain so long files don't balloon memory.
    if (encoder.encodeQueueSize > 16) {
      await new Promise<void>(resolve => {
        const check = () => (encoder.encodeQueueSize <= 4 ? resolve() : setTimeout(check, 10));
        check();
      });
    }
    onProgress?.(Math.min(1, (offset + frames) / total));
  }

  await encoder.flush();
  encoder.close();
  if (encoderError) throw encoderError;

  muxer.finalize();
  return new Blob([target.buffer], { type: 'audio/mp4' });
}

/**
 * Encode a slice to MP3. The browser has no native MP3 encoder, so this uses
 * lame compiled to JS; it runs in chunks to keep the UI responsive.
 */
export async function encodeToMP3(
  buffer: AudioBuffer,
  startSec: number,
  endSec: number,
  onProgress?: (fraction: number) => void,
): Promise<Blob> {
  const sampleRate = buffer.sampleRate;
  const channels = Math.min(2, buffer.numberOfChannels);
  const startFrame = Math.max(0, Math.floor(startSec * sampleRate));
  const endFrame = Math.min(buffer.length, Math.ceil(endSec * sampleRate));
  const total = endFrame - startFrame;
  if (total <= 0) throw new Error('The selected range is empty.');

  const encoder = new Mp3Encoder(channels, sampleRate, 128);
  const parts: Uint8Array[] = [];
  const left = buffer.getChannelData(0);
  const right = channels > 1 ? buffer.getChannelData(1) : null;

  // lame wants 16-bit signed samples.
  const toInt16 = (src: Float32Array, from: number, count: number) => {
    const out = new Int16Array(count);
    for (let i = 0; i < count; i++) {
      const v = Math.max(-1, Math.min(1, src[from + i]));
      out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    return out;
  };

  const CHUNK = 1152 * 50; // whole MP3 frames
  for (let offset = 0; offset < total; offset += CHUNK) {
    const frames = Math.min(CHUNK, total - offset);
    const l = toInt16(left, startFrame + offset, frames);
    const r = right ? toInt16(right, startFrame + offset, frames) : undefined;
    const block = r ? encoder.encodeBuffer(l, r) : encoder.encodeBuffer(l);
    if (block.length > 0) parts.push(new Uint8Array(block));
    onProgress?.(Math.min(1, (offset + frames) / total));
    // Yield so the progress label can paint.
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  const tail = encoder.flush();
  if (tail.length > 0) parts.push(new Uint8Array(tail));

  return new Blob(parts as BlobPart[], { type: 'audio/mpeg' });
}

export function encodeAudio(
  format: AudioFormat,
  buffer: AudioBuffer,
  startSec: number,
  endSec: number,
  onProgress?: (fraction: number) => void,
): Promise<Blob> {
  return format === 'mp3'
    ? encodeToMP3(buffer, startSec, endSec, onProgress)
    : encodeToM4A(buffer, startSec, endSec, onProgress);
}
