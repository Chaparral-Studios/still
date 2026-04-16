#!/usr/bin/env node
// Inspect the top-motion frames of a recording. For each of the top N non-scroll
// frames by motion score, produces:
//   - prev.png / curr.png (the two frames being diffed)
//   - diff_luma.png (grayscale luminance diff, contrast-amplified)
//   - diff_r.png / diff_g.png / diff_b.png (per-channel diffs)
//   - diff_chroma.png (UV-plane diff — catches pure hue shifts that luma misses)
//   - hist.png (histogram of the luma diff — shows if change is concentrated in
//     a few pixels with big deltas vs many pixels with tiny deltas)
//   - stats.json (ffmpeg signalstats on each diff: YAVG, YMAX, counts)
//
// Writes a top-level inspect/summary.md tying it all together.
//
// Usage: tsx inspect.mts --in <report-dir> [--top 5]

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
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
const topN = parseInt(arg('top', '5'), 10);
const video = join(dir, 'recording.webm');
const framesDir = join(dir, 'frames');
const frameTimesFile = join(dir, 'frame_times.json');
const csvPath = join(dir, 'motion.csv');
const scrollFile = join(dir, 'scroll_times.json');

const useFrames = existsSync(framesDir) && existsSync(frameTimesFile);
if (!existsSync(csvPath) || (!useFrames && !existsSync(video))) {
  console.error('need motion.csv plus either recording.webm or frames/+frame_times.json in', dir);
  process.exit(1);
}

// If PNG sourced, build a (t → index) lookup so we can fetch the nearest captured
// frame for any motion.csv timestamp.
type FrameTime = { idx: number; t: number };
const frameTimes: FrameTime[] = useFrames
  ? JSON.parse(readFileSync(frameTimesFile, 'utf8')).frameTimes
  : [];
function nearestFrame(t: number): FrameTime {
  let best = frameTimes[0];
  let bestDelta = Math.abs(best.t - t);
  for (const ft of frameTimes) {
    const d = Math.abs(ft.t - t);
    if (d < bestDelta) { best = ft; bestDelta = d; }
  }
  return best;
}
function pngPathForIdx(idx: number): string {
  return join(framesDir, String(idx).padStart(6, '0') + '.png');
}

// Load scroll times (may be empty for sit-mode runs).
const scrollTimes: number[] = existsSync(scrollFile)
  ? JSON.parse(readFileSync(scrollFile, 'utf8')).scrollTimes
  : [];
const MASK = 0.4;
const isScroll = (t: number) => scrollTimes.some((s) => Math.abs(t - s) < MASK);

// Parse motion.csv, drop scroll frames, pick top N.
const lines = readFileSync(csvPath, 'utf8').trim().split('\n').slice(1);
type Row = { t: number; y: number };
const rows: Row[] = lines.map((l) => {
  const [t, y] = l.split(',').map(Number);
  return { t, y };
}).filter((r) => !isScroll(r.t));

const top = rows.slice().sort((a, b) => b.y - a.y).slice(0, topN);

const outRoot = join(dir, 'inspect');
mkdirSync(outRoot, { recursive: true });

function ff(args: string[]): void {
  execFileSync('ffmpeg', ['-y', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
}
function ffOut(args: string[]): string {
  return execFileSync('ffmpeg', ['-y', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// Run ffmpeg with metadata=print on a single file and parse one set of stats.
// metadata=print writes to stderr, so capture it via spawnSync.
function signalstats(pngPath: string): Record<string, number> {
  const res = spawnSync('ffmpeg', [
    '-y', '-i', pngPath,
    '-vf', 'signalstats,metadata=print',
    '-f', 'null', '-',
  ], { encoding: 'utf8' });
  const stats: Record<string, number> = {};
  for (const line of (res.stderr || '').split('\n')) {
    const m = line.match(/lavfi\.signalstats\.(\w+)=([\d.-]+)/);
    if (m) stats[m[1]] = parseFloat(m[2]);
  }
  return stats;
}

type FrameReport = {
  label: string;
  t: number;
  y: number;
  prevOffset: number;
  dir: string;
  stats: {
    luma: Record<string, number>;
    r: Record<string, number>;
    g: Record<string, number>;
    b: Record<string, number>;
    chroma: Record<string, number>;
  };
};

const reports: FrameReport[] = [];

// Long-baseline: first stable frame vs last frame. Catches slow drift that
// frame-to-frame diffs miss (e.g., hue breathing over 30+ seconds).
type Probe = { t: number; y: number; label: string; prevOffset: number };
const probes: Probe[] = top.map((r, i) => ({ t: r.t, y: r.y, label: String(i + 1).padStart(2, '0'), prevOffset: 0.1 }));
if (rows.length > 20) {
  // Skip the first ~2s (initial render) and compare a settled frame to the last.
  const firstSettled = rows.find((r) => r.t > 2.0);
  const last = rows[rows.length - 1];
  if (firstSettled && last && last.t > firstSettled.t + 1) {
    probes.push({
      t: last.t, y: last.y, label: 'baseline_first_vs_last',
      prevOffset: last.t - firstSettled.t,
    });
  }
}

for (let i = 0; i < probes.length; i++) {
  const { t, y, label, prevOffset } = probes[i];
  const frameDir = join(outRoot, `${label}_t${t.toFixed(2)}`);
  mkdirSync(frameDir, { recursive: true });
  const tPrev = Math.max(0, t - prevOffset);
  const prev = join(frameDir, 'prev.png');
  const curr = join(frameDir, 'curr.png');

  if (useFrames) {
    // Lossless path: pick the captured PNG for `curr` and its indexed predecessor
    // for `prev`. Indexed predecessor is correct because that's exactly what
    // analyze.mts diffed. Time-delta lookup would wrongly return the same frame
    // when capture cadence is slower than prevOffset.
    const currFt = nearestFrame(t);
    // For baseline_first_vs_last, we want the predecessor to be at `firstSettled`
    // (not idx-1), so honor a large prevOffset by using nearestFrame on tPrev.
    const prevFt = prevOffset > 0.3 ? nearestFrame(tPrev) : frameTimes[Math.max(0, currFt.idx - 1)];
    copyFileSync(pngPathForIdx(prevFt.idx), prev);
    copyFileSync(pngPathForIdx(currFt.idx), curr);
  } else {
    // WebM path: seek via ffmpeg. Lossy by encoder, but fine for large motion.
    ff(['-ss', String(tPrev), '-i', video, '-frames:v', '1', prev]);
    ff(['-ss', String(t), '-i', video, '-frames:v', '1', curr]);
  }

  // Luma diff (grayscale), contrast-amplified ×8 so subtle changes are visible.
  const diffLuma = join(frameDir, 'diff_luma.png');
  ff(['-i', prev, '-i', curr,
      '-filter_complex', '[0:v][1:v]blend=all_mode=difference,format=gray,eq=contrast=8',
      '-frames:v', '1', diffLuma]);

  // Per-channel diffs. extractplanes gives us R, G, B planes as grayscale,
  // then we diff same-plane-pairs.
  function channelDiff(plane: 'r' | 'g' | 'b'): string {
    const out = join(frameDir, `diff_${plane}.png`);
    ff(['-i', prev, '-i', curr,
        '-filter_complex',
        `[0:v]format=rgb24,extractplanes=${plane}[a];` +
        `[1:v]format=rgb24,extractplanes=${plane}[b];` +
        `[a][b]blend=all_mode=difference,eq=contrast=8`,
        '-frames:v', '1', out]);
    return out;
  }
  const diffR = channelDiff('r');
  const diffG = channelDiff('g');
  const diffB = channelDiff('b');

  // Chroma diff: difference of U+V planes (hue shift detector, independent of luma).
  const diffChroma = join(frameDir, 'diff_chroma.png');
  ff(['-i', prev, '-i', curr,
      '-filter_complex',
      '[0:v]format=yuv420p,extractplanes=u+v[au][av];' +
      '[1:v]format=yuv420p,extractplanes=u+v[bu][bv];' +
      '[au][bu]blend=all_mode=difference[du];' +
      '[av][bv]blend=all_mode=difference[dv];' +
      '[du][dv]vstack,eq=contrast=8',
      '-frames:v', '1', diffChroma]);

  // Histogram of the luma diff.
  const hist = join(frameDir, 'hist.png');
  ff(['-i', diffLuma,
      '-vf', 'histogram=display_mode=stack',
      '-update', '1', '-frames:v', '1', hist]);

  const stats = {
    luma: signalstats(diffLuma),
    r: signalstats(diffR),
    g: signalstats(diffG),
    b: signalstats(diffB),
    chroma: signalstats(diffChroma),
  };
  writeFileSync(join(frameDir, 'stats.json'), JSON.stringify(stats, null, 2));
  reports.push({ label, t, y, prevOffset, dir: frameDir, stats });
  console.log(`${label}: t=${t.toFixed(2)}s Δt=${prevOffset.toFixed(2)}s y=${y.toFixed(2)} → ${frameDir}`);
}

// Summary markdown.
const lines2: string[] = [];
lines2.push(`# Motion inspection — ${dir}`);
lines2.push('');
lines2.push(`Top ${reports.length} non-scroll moving frames. Stats are ffmpeg signalstats on the amplified diff image; YAVG=average brightness, YMAX=peak brightness (both 0–255). A high YAVG with low YMAX = scattered tiny shifts (tint/breathing). Low YAVG with high YMAX = localized flicker.`);
lines2.push('');
lines2.push('| label | t (s) | Δt (s) | motion | luma YAVG | luma YMAX | R avg | G avg | B avg | chroma avg |');
lines2.push('|-------|------:|-------:|-------:|----------:|----------:|------:|------:|------:|-----------:|');
for (const r of reports) {
  const n = (x: number | undefined) => (x == null || Number.isNaN(x) ? '—' : x.toFixed(2));
  lines2.push(`| ${r.label} | ${r.t.toFixed(2)} | ${r.prevOffset.toFixed(2)} | ${r.y.toFixed(2)} | ${n(r.stats.luma.YAVG)} | ${n(r.stats.luma.YMAX)} | ${n(r.stats.r.YAVG)} | ${n(r.stats.g.YAVG)} | ${n(r.stats.b.YAVG)} | ${n(r.stats.chroma.YAVG)} |`);
}
lines2.push('');
lines2.push('Rows 01–N compare consecutive frames (Δt≈0.1s) — fast-moving content.');
lines2.push('Row `baseline_first_vs_last` compares first settled frame to last — catches slow drift that frame-to-frame diffs miss.');
lines2.push('');
lines2.push('Per-frame artifacts in `inspect/<rank>_t<time>/`:');
lines2.push('- `prev.png`, `curr.png` — the two compared frames');
lines2.push('- `diff_luma.png` — amplified grayscale diff');
lines2.push('- `diff_r.png`, `diff_g.png`, `diff_b.png` — per-channel RGB diffs');
lines2.push('- `diff_chroma.png` — hue-shift detector (UV planes)');
lines2.push('- `hist.png` — histogram of luma diff (many small vs few large pixels)');
writeFileSync(join(outRoot, 'summary.md'), lines2.join('\n') + '\n');
console.log(`\nwrote ${join(outRoot, 'summary.md')}`);
