#!/usr/bin/env node
// Per-pixel temporal-variance analyzer. For each pixel location in the recording,
// compute the standard deviation of its luminance across all captured frames.
// High per-pixel std-dev = the pixel flickers over time — the signature of
// sustained 10-60 Hz motion that migraine-sensitive eyes pick up even when
// individual frame diffs look tiny.
//
// Produces:
//   - variance_heatmap.png  (per-pixel std-dev, amplified for visibility)
//   - variance_rgb.png      (three-channel std-dev: R/G/B side by side)
//   - variance.json         (summary stats: mean/max std-dev, % high-variance pixels)
//
// Usage: tsx variance.mts --in <dir>

import { readdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

function arg(name: string): string | undefined;
function arg(name: string, fallback: string): string;
function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const inArg = arg('in');
if (!inArg) { console.error('--in required'); process.exit(1); }
const dir = resolve(inArg);
const framesDir = join(dir, 'frames');
const frameTimesFile = join(dir, 'frame_times.json');
// Optional time window — for excluding the scrolling portion of a
// scroll-then-sit recording so variance reflects only the post-settle period.
const startT = parseFloat(arg('start-time', '0'));
const endT = parseFloat(arg('end-time', '1e9'));
if (!existsSync(framesDir) || !existsSync(frameTimesFile)) {
  console.error('need frames/ and frame_times.json in', dir); process.exit(1);
}

const frameTimesAll: { idx: number; t: number }[] =
  JSON.parse(readFileSync(frameTimesFile, 'utf8')).frameTimes;
const frameIdxInWindow = new Set(
  frameTimesAll.filter((ft) => ft.t >= startT && ft.t <= endT).map((ft) => ft.idx)
);
const allFiles = readdirSync(framesDir)
  .filter((f) => /\.(jpe?g|png)$/i.test(f))
  .sort();
const frameFiles = allFiles.filter((f) => {
  const idx = parseInt(f.slice(0, 6), 10);
  return frameIdxInWindow.size === 0 || frameIdxInWindow.has(idx);
});
if (frameFiles.length < 2) {
  console.error('need at least 2 frames; have', frameFiles.length); process.exit(1);
}
if (startT > 0 || endT < 1e9) {
  console.log(`  window: t=${startT}s–${endT === 1e9 ? 'end' : endT + 's'} → ${frameFiles.length}/${allFiles.length} frames`);
}

console.log(`analyzing ${frameFiles.length} frames from ${framesDir}`);

// First frame: learn dimensions.
const firstRaw = await sharp(join(framesDir, frameFiles[0])).raw().toBuffer({ resolveWithObject: true });
const { width, height, channels } = firstRaw.info;
const pixelCount = width * height;
console.log(`  dims: ${width}×${height} (${channels} channels)`);

// Running accumulators per channel. Float64 to avoid overflow on sum-of-squares
// (a single pixel's value² = up to 65025; 600 frames → 39M, fits comfortably).
const sumR = new Float64Array(pixelCount);
const sumG = new Float64Array(pixelCount);
const sumB = new Float64Array(pixelCount);
const sqR = new Float64Array(pixelCount);
const sqG = new Float64Array(pixelCount);
const sqB = new Float64Array(pixelCount);

let n = 0;
for (const f of frameFiles) {
  const { data, info } = await sharp(join(framesDir, f)).raw().toBuffer({ resolveWithObject: true });
  if (info.width !== width || info.height !== height) continue; // skip any odd frame
  // data is Uint8 interleaved RGB(A). Channels may be 3 or 4.
  const ch = info.channels;
  for (let i = 0, p = 0; i < data.length; i += ch, p++) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    sumR[p] += r; sumG[p] += g; sumB[p] += b;
    sqR[p] += r * r; sqG[p] += g * g; sqB[p] += b * b;
  }
  n++;
  if (n % 50 === 0) console.log(`  ${n}/${frameFiles.length}`);
}

// Per-pixel std-dev and amplified heatmaps.
// var = E[X²] - E[X]²  → σ = sqrt(var)
const lumaStd = new Uint8Array(pixelCount);
const rStd = new Uint8Array(pixelCount);
const gStd = new Uint8Array(pixelCount);
const bStd = new Uint8Array(pixelCount);

let maxLuma = 0, sumLuma = 0;
let highVarCount = 0; // pixels with σ > 2 (i.e., clearly flickering above noise)
const AMP = 8;
for (let p = 0; p < pixelCount; p++) {
  const mR = sumR[p] / n, mG = sumG[p] / n, mB = sumB[p] / n;
  const vR = Math.max(0, sqR[p] / n - mR * mR);
  const vG = Math.max(0, sqG[p] / n - mG * mG);
  const vB = Math.max(0, sqB[p] / n - mB * mB);
  const sR = Math.sqrt(vR), sG = Math.sqrt(vG), sB = Math.sqrt(vB);
  // Luma approx (Rec.601): 0.299 R + 0.587 G + 0.114 B. Apply to std-dev as a
  // scalar — not strictly correct (variance of a linear combination ≠ weighted
  // sum of component std-devs) but close enough for visualization.
  const sL = 0.299 * sR + 0.587 * sG + 0.114 * sB;
  lumaStd[p] = Math.min(255, Math.round(sL * AMP));
  rStd[p]    = Math.min(255, Math.round(sR * AMP));
  gStd[p]    = Math.min(255, Math.round(sG * AMP));
  bStd[p]    = Math.min(255, Math.round(sB * AMP));
  if (sL > maxLuma) maxLuma = sL;
  sumLuma += sL;
  if (sL > 2) highVarCount++;
}

const suffix = (startT > 0 || endT < 1e9) ? `_t${startT}-${endT}` : '';
await sharp(Buffer.from(lumaStd.buffer), { raw: { width, height, channels: 1 } })
  .png()
  .toFile(join(dir, `variance_heatmap${suffix}.png`));

// Three-channel side-by-side image (R | G | B amplified std-dev).
const rgbStack = Buffer.alloc(pixelCount * 3 * 3);
// Fill the three panels column-major: r in cols 0..w-1, g in w..2w-1, b in 2w..3w-1.
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const srcIdx = y * width + x;
    rgbStack[(y * (3 * width) + x) * 3 + 0] = rStd[srcIdx];
    rgbStack[(y * (3 * width) + x) * 3 + 1] = rStd[srcIdx];
    rgbStack[(y * (3 * width) + x) * 3 + 2] = rStd[srcIdx];
    rgbStack[(y * (3 * width) + x + width) * 3 + 0] = gStd[srcIdx];
    rgbStack[(y * (3 * width) + x + width) * 3 + 1] = gStd[srcIdx];
    rgbStack[(y * (3 * width) + x + width) * 3 + 2] = gStd[srcIdx];
    rgbStack[(y * (3 * width) + x + 2 * width) * 3 + 0] = bStd[srcIdx];
    rgbStack[(y * (3 * width) + x + 2 * width) * 3 + 1] = bStd[srcIdx];
    rgbStack[(y * (3 * width) + x + 2 * width) * 3 + 2] = bStd[srcIdx];
  }
}
await sharp(rgbStack, { raw: { width: width * 3, height, channels: 3 } })
  .png()
  .toFile(join(dir, `variance_rgb${suffix}.png`));

const result = {
  window: { startT, endT: endT === 1e9 ? null : endT },
  frames: n,
  meanLumaStd: +(sumLuma / pixelCount).toFixed(4),
  maxLumaStd: +maxLuma.toFixed(4),
  highVariancePixels: highVarCount,
  highVariancePct: +(100 * highVarCount / pixelCount).toFixed(3),
  amplification: AMP,
};
writeFileSync(join(dir, `variance${suffix}.json`), JSON.stringify(result, null, 2));
console.log('\n' + JSON.stringify(result, null, 2));
