#!/usr/bin/env node
// Frame-diff analyzer. Reads recording.webm, writes motion.csv + heatmap.png + summary.json.
// Usage: tsx analyze.ts --in <dir>

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

function arg(name: string): string | undefined;
function arg(name: string, fallback: string): string;
function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const inArg = arg('in');
if (!inArg) { console.error('--in required'); process.exit(1); }
const dir = resolve(inArg);
const video = join(dir, 'recording.webm');
const framesDir = join(dir, 'frames');
const frameTimesFile = join(dir, 'frame_times.json');
const metaLog = join(dir, 'motion.log');
const csvPath = join(dir, 'motion.csv');
const heatmap = join(dir, 'heatmap.png');
const summary = join(dir, 'summary.json');

// Two input modes:
//   A. WebM recording  (lossy VP8, 25fps, resampled to 10fps for analysis)
//   B. PNG sequence    (lossless, written by record.mts --png-capture)
// The PNG path is required for detecting sub-1-luminance signal (subpixel AA
// jitter, slow tint drift) because VP8 quantization masks it.
const useFrames = existsSync(framesDir) && existsSync(frameTimesFile);
// Detect frame extension (record.mts --png-capture writes .png; CDP screencast
// writes .jpg). Both use zero-padded %06d names.
const frameExt = useFrames
  ? (readdirSync(framesDir).find((f) => /\.(png|jpe?g)$/i.test(f))?.match(/\.(png|jpe?g)$/i)?.[0] || '.jpg')
  : '.jpg';
if (!useFrames && !existsSync(video)) {
  console.error('need recording.webm OR frames/ + frame_times.json in', dir);
  process.exit(1);
}

// Pass 1: per-frame YAVG of inter-frame difference.
// tblend=difference gives |frame - prev|; signalstats publishes YAVG on that diff.
if (useFrames) {
  // Drive from the PNG sequence; ffmpeg's image2 demuxer walks the indexed names.
  execFileSync('ffmpeg', [
    '-y', '-framerate', '10', '-i', join(framesDir, `%06d${frameExt}`),
    '-vf', `tblend=all_mode=difference,signalstats,metadata=print:file=${metaLog}`,
    '-f', 'null', '-',
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
} else {
  execFileSync('ffmpeg', [
    '-y', '-i', video,
    '-vf', `fps=10,tblend=all_mode=difference,signalstats,metadata=print:file=${metaLog}`,
    '-f', 'null', '-',
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
}

// Parse metadata log: lines like "lavfi.signalstats.YAVG=1.234"
// The log's `pts_time` is relative to the ffmpeg stream. For PNG input that's
// frame_index / framerate, not wall-clock capture time — we remap to the real
// timestamps we wrote during capture so scroll masking stays correct.
const log = readFileSync(metaLog, 'utf8');
type Score = { t: number; y: number };
const scores: Score[] = [];
let curFrame: number | null = null;
for (const line of log.split('\n')) {
  const pts = line.match(/pts_time:([\d.]+)/);
  if (pts) curFrame = parseFloat(pts[1]);
  // Accept scientific notation — on near-identical frames ffmpeg emits values
  // like `7.71484e-05`, and a [\d.]-only capture silently truncated the exponent
  // and read that as 7.71484 (a huge value from a numerically-zero diff).
  const m = line.match(/lavfi\.signalstats\.YAVG=([-+eE\d.]+)/);
  if (m && curFrame != null) scores.push({ t: curFrame, y: parseFloat(m[1]) });
}
if (useFrames) {
  const frameTimes: { idx: number; t: number }[] =
    JSON.parse(readFileSync(frameTimesFile, 'utf8')).frameTimes;
  // ffmpeg pts_time at 10fps is idx/10; signalstats emits one event per diff
  // frame, so record i corresponds to captured frame i+1 (no diff for first).
  for (let i = 0; i < scores.length; i++) {
    const targetIdx = i + 1;
    if (targetIdx < frameTimes.length) scores[i].t = frameTimes[targetIdx].t;
  }
}

// Write CSV.
const csv = ['t,motion', ...scores.map((s) => `${s.t.toFixed(3)},${s.y.toFixed(4)}`)].join('\n');
writeFileSync(csvPath, csv + '\n');

// Pass 2: heatmap. lagfun with decay=1.0 keeps per-pixel max over time; -update 1 overwrites
// same file each frame, so the final PNG is the accumulated motion map.
if (useFrames) {
  execFileSync('ffmpeg', [
    '-y', '-framerate', '10', '-i', join(framesDir, `%06d${frameExt}`),
    '-vf', 'tblend=all_mode=difference,format=gray,lagfun=decay=1.0,eq=contrast=4',
    '-update', '1', '-frames:v', '99999', heatmap,
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
} else {
  execFileSync('ffmpeg', [
    '-y', '-i', video,
    '-vf', 'fps=10,tblend=all_mode=difference,format=gray,lagfun=decay=1.0,eq=contrast=4',
    '-update', '1', '-frames:v', '99999', heatmap,
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
}

// Mask scroll moments (±0.4s around each scroll) so viewport motion doesn't count.
const scrollFile = join(dir, 'scroll_times.json');
const scrollTimes: number[] = existsSync(scrollFile) ? JSON.parse(readFileSync(scrollFile, 'utf8')).scrollTimes : [];
const MASK = 0.4;
const isScroll = (t: number) => scrollTimes.some((s) => Math.abs(t - s) < MASK);
const kept = scores.filter((s) => !isScroll(s.t));
const masked = scores.length - kept.length;

// Summary stats — computed over non-scroll frames only.
const ys = kept.map((s) => s.y);
const sum = ys.reduce((a, b) => a + b, 0);
const mean = ys.length ? sum / ys.length : 0;
const max = ys.length ? Math.max(...ys) : 0;
// Lossless PNG input has no encoder floor, so real signal can be much smaller.
// For WebM we keep the 1.5-unit floor (VP8 keyframe noise); for PNG we drop to
// 0.05 since any non-zero mean diff is a real pixel change.
const MOTION_FLOOR = useFrames ? 0.05 : 1.5;
const moving = ys.filter((v) => v > MOTION_FLOOR).length;
const movingPct = ys.length ? moving / ys.length : 0;

const result = { input: useFrames ? 'png' : 'webm', frames: ys.length, maskedScrollFrames: masked, meanMotion: +mean.toFixed(4), maxMotion: +max.toFixed(4), movingFramesPct: +(movingPct * 100).toFixed(1) };
writeFileSync(summary, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
