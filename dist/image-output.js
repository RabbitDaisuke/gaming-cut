export function stillDimensions(bounds, divisor = 1) {
  if (![1, 2, 4].includes(divisor)) throw Error('静止画のサイズが不正です');
  return {width: Math.max(1, Math.round(bounds.width / divisor)), height: Math.max(1, Math.round(bounds.height / divisor))};
}

// Inspect actual alpha once per imported image, in small strips, without resizing.
export function imageIsOpaque(image, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = Math.min(128, height);
  const ctx = canvas.getContext('2d', {willReadFrequently: true});
  try {
    for (let y = 0; y < height; y += canvas.height) {
      const rows = Math.min(canvas.height, height - y);
      ctx.clearRect(0, 0, width, canvas.height);
      ctx.drawImage(image, 0, y, width, rows, 0, 0, width, rows);
      const pixels = ctx.getImageData(0, 0, width, rows).data;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 255) return false;
    }
    return true;
  } finally {canvas.width = canvas.height = 1;}
}

export const canExportJpeg = image => !!image?.keepBackground && image.opaqueSource === true;

export function encodeStill(canvas, format) {
  const mime = {webp: 'image/webp', png: 'image/png', jpeg: 'image/jpeg'}[format];
  if (!mime) throw Error('保存形式が不正です');
  // Never flatten transparent pixels for JPEG. Check the final raster as well.
  if (format === 'jpeg' && !imageIsOpaque(canvas, canvas.width, canvas.height))
    throw Error('透過を含む画像はJPEGに保存できません。WebPかPNGを選択してください。');
  const quality = format === 'webp' ? .85 : format === 'jpeg' ? .95 : undefined;
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    if (!blob) reject(Error(format.toUpperCase() + 'を書き出せません'));
    else if (blob.type !== mime) reject(Error('このブラウザは' + format.toUpperCase() + '保存に対応していません。PNGを選択してください。'));
    else resolve(blob);
  }, mime, quality));
}
