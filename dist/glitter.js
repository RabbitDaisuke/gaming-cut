// Shared composition for preview, PNG and MP4. Inference never runs here.
export const LOOP_FRAMES = 80, LOOP_FPS = 25;
export const LOOP_MS = LOOP_FRAMES / LOOP_FPS * 1000;
export function makeCanvas(width, height) {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
  c.width = width; c.height = height; return c;
}
export function mirrorTile(texture) {
  // Both formats use flakes at 1/4 the source texture size. Reflection matches
  // adjoining edges and at both ends of the full repeating tile.
  const w = Math.max(1, Math.round(texture.width / 4));
  const h = Math.max(1, Math.round(texture.height / 4));
  const tile = makeCanvas(w * 2, h * 2), ctx = tile.getContext('2d');
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    ctx.save(); ctx.translate(x ? w * 2 : 0, y ? h * 2 : 0);
    ctx.scale(x ? -1 : 1, y ? -1 : 1);
    ctx.drawImage(texture, 0, 0, w, h); ctx.restore();
  }
  return tile;
}
export function overlayGlitter(ctx, texture, tile, bounds, imageWidth, imageHeight, amount, phase = 0) {
  if (!texture || amount <= 0) return;
  const width = ctx.canvas.width, height = ctx.canvas.height;
  ctx.save();
  // source-atop preserves the original alpha, including eraser marks.
  // 30% glitter leaves 70% of the original photograph at every opaque pixel.
  ctx.globalCompositeOperation = 'source-atop'; ctx.globalAlpha = Math.min(1, Math.max(0, amount));
  ctx.scale(width / bounds.width, height / bounds.height);
  ctx.translate(-bounds.x, -bounds.y);
  const scale = Math.max(imageWidth / texture.width, imageHeight / texture.height);
  const pattern = ctx.createPattern(tile, 'repeat');
  const t = ((phase % 1) + 1) % 1;
  // PNG freezes one of these same video frames before encoding or matte fill.
  // One complete tile displacement is exactly periodic.
  ctx.scale(scale, scale);
  const dx = tile.width * t, dy = tile.height * t;
  ctx.translate(dx, dy); ctx.fillStyle = pattern;
  ctx.fillRect(bounds.x / scale - dx, bounds.y / scale - dy, bounds.width / scale, bounds.height / scale);
  ctx.restore();
}

export function composeFrame(ctx, options, effect) {
  const {base, mask, texture, tile, bounds, imageWidth, imageHeight,
    amount, phase = 0, keepBackground = true, matte = null} = options;
  const {width, height} = ctx.canvas;
  ctx.save(); ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, width, height); ctx.drawImage(base, 0, 0, width, height);
  if (mask) {
    if (keepBackground && texture && amount > 0) {
      // Only the effect is masked: the original photograph underneath is intact.
      effect ||= makeCanvas(width, height);
      if (effect.width !== width || effect.height !== height) { effect.width = width; effect.height = height; }
      const ex = effect.getContext('2d'); ex.clearRect(0, 0, width, height);
      ex.drawImage(mask, 0, 0, width, height);
      overlayGlitter(ex, texture, tile, bounds, imageWidth, imageHeight, 1, phase);
      ctx.globalAlpha = Math.min(.75, Math.max(0, amount)); ctx.drawImage(effect, 0, 0); ctx.globalAlpha = 1;
    } else if (!keepBackground) {
      overlayGlitter(ctx, texture, tile, bounds, imageWidth, imageHeight, amount, phase);
      ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(mask, 0, 0, width, height);
    }
  } else if (!keepBackground) ctx.clearRect(0, 0, width, height);
  if (matte) {
    // MP4 is always opaque: original photo when enabled, chosen solid color otherwise.
    ctx.globalCompositeOperation = 'destination-over'; ctx.fillStyle = matte; ctx.fillRect(0, 0, width, height);
  }
  ctx.restore();
}
