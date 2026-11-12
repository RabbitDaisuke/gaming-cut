import { Muxer, ArrayBufferTarget } from './vendor/mp4-muxer.js';
import { mirrorTile, composeFrame, LOOP_FRAMES, LOOP_FPS } from './glitter.js?v=glitter-v6';

const fps = LOOP_FPS, frames = LOOP_FRAMES, duration = 1_000_000 / fps;
self.onmessage = async ({data}) => {
  const {base, mask, texture, ...options} = data;
  let encoder;
  try {
    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined')
      throw Error('このブラウザではMP4の作成に対応していません。WebCodecs対応のChrome / Edge等で開いてください。');
    const {width, height} = base;
    const bitrate = Math.min(4_000_000, Math.max(800_000, Math.round(width * height * 2.2)));
    let config;
    for (const codec of ['avc1.420028', 'avc1.640028', 'avc1.420033', 'avc1.640033']) {
      const candidate = {codec, width, height, bitrate, framerate: fps,
        latencyMode: 'realtime', bitrateMode: 'variable', avc: {format: 'avc'}};
      const support = await VideoEncoder.isConfigSupported(candidate);
      if (support.supported) {config = support.config; break;}
    }
    if (!config) throw Error('この端末でH.264を作成できません。MP4の大きさを小さくして再試行してください。');
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({target, video: {codec: 'avc', width, height, frameRate: fps},
      fastStart: {expectedVideoChunks: frames}});
    let failure;
    encoder = new VideoEncoder({
      output(chunk, meta) {try {muxer.addVideoChunk(chunk, meta);} catch (error) {failure = error;}},
      error(error) {failure = error;}
    });
    encoder.configure(config);
    const canvas = new OffscreenCanvas(width, height), effect = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d'), tile = mirrorTile(texture);
    for (let i = 0; i < frames; i++) {
      if (failure) throw failure;
      composeFrame(ctx, {base, mask, texture, tile, ...options, phase: i / frames}, effect);
      const frame = new VideoFrame(canvas, {timestamp: i * duration, duration});
      try {encoder.encode(frame, {keyFrame: i === 0});} finally {frame.close();}
      // Drain in small batches: never retain an entire loop of raw RGBA frames.
      if (i % 4 === 3) await encoder.flush();
      if (failure) throw failure;
      self.postMessage({type: 'progress', value: Math.round((i + 1) / frames * 100)});
    }
    await encoder.flush(); if (failure) throw failure;
    muxer.finalize();
    self.postMessage({type: 'done', bytes: target.buffer}, [target.buffer]);
  } catch (error) {
    self.postMessage({type: 'error', message: error.message || String(error)});
  } finally {
    if (encoder && encoder.state !== 'closed') encoder.close();
    base.close(); mask.close(); texture.close();
  }
};
