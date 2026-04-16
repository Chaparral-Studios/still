#!/usr/bin/env node
// Frame-diff analyzer. Reads recording.webm, writes motion.csv + heatmap.png + summary.json.
// Usage: tsx analyze.ts --in <dir>

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
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
const metaLog = join(dir, 'motion.log');
const csvPath = join(dir, 'motion.csv');
const heatmap = join(dir, 'heatmap.png');
const summary = join(dir, 'summary.json');

if (!existsSync(video)) { console.error('no recording.webm in', dir); process.exit(1); }

// Pass 1: per-frame YAVG of inter-frame difference @ 10fps.
// tblend=difference gives |frame - prev|; signalstats publishes YAVG on that diff.
execFileSync('ffmpeg', [
  '-y', '-i', video,
  '-vf', `fps=10,tblend=all_mode=difference,signalstats,metadata=print:file=${metaLog}`,
  '-f', 'null', '-',
], { stdio: ['ignore', 'ignore', 'inherit'] });

// Parse metadata log: lines like "lavfi.signalstats.YAVG=1.234"
const log = readFileSync(metaLog, 'utf8');
type Score = { t: number; y: number };
const scores: Score[] = [];
let curFrame: number | null = null;
for (const line of log.split('\n')) {
  const pts = line.match(/pts_time:([\d.]+)/);
  if (pts) curFrame = parseFloat(pts[1]);
  const m = line.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
  if (m && curFrame != null) scores.push({ t: curFrame, y: parseFloat(m[1]) });
}

// Write CSV.
const csv = ['t,motion', ...scores.map((s) => `${s.t.toFixed(3)},${s.y.toFixed(4)}`)].join('\n');
writeFileSync(csvPath, csv + '\n');

// Pass 2: heatmap. lagfun with decay=1.0 keeps per-pixel max over time; -update 1 overwrites
// same file each frame, so the final PNG is the accumulated motion map.
execFileSync('ffmpeg', [
  '-y', '-i', video,
  '-vf', 'fps=10,tblend=all_mode=difference,format=gray,lagfun=decay=1.0,eq=contrast=4',
  '-update', '1', '-frames:v', '99999', heatmap,
], { stdio: ['ignore', 'ignore', 'inherit'] });

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
// Fraction of frames whose motion exceeds the VP8 encoder noise floor. Verified
// empirically: at keyframe boundaries (~every 5s) we see motion=1.00 spikes, but
// extracting those frames and pixel-diffing them shows byte-identical output
// (i.e., compression quantization, not real content). 1.5 is a safe real-signal
// threshold; anything under is encoder noise.
const MOTION_FLOOR = 1.5;
const moving = ys.filter((v) => v > MOTION_FLOOR).length;
const movingPct = ys.length ? moving / ys.length : 0;

const result = { frames: ys.length, maskedScrollFrames: masked, meanMotion: +mean.toFixed(3), maxMotion: +max.toFixed(3), movingFramesPct: +(movingPct * 100).toFixed(1) };
writeFileSync(summary, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
