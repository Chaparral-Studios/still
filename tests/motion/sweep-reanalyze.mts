// Recompute the frame-diff channel for a finished sweep from the FINALIZED
// recordings (the in-run analysis can read a not-yet-finalized file), then
// re-derive issues and rewrite summary.md / summary.json.
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const dir = resolve(process.argv[2] || 'tests/motion/reports/sweep_full');
const SIT_S = 4;
const results: any[] = [];
for (const name of readdirSync(dir)) {
  const sd = join(dir, name); if (!statSync(sd).isDirectory()) continue;
  const rp = join(sd, 'result.json'); if (!existsSync(rp)) continue;
  const r = JSON.parse(readFileSync(rp, 'utf8'));
  const webms = readdirSync(sd).filter((f) => f.endsWith('.webm')).map((f) => ({ f: join(sd, f), size: statSync(join(sd, f)).size })).sort((a, b) => b.size - a.size);
  if (webms.length && r.ok) {
    for (const label of ['sitA', 'sitB']) {
      const w = r[label] && r[label].videoWindow; if (!w) continue;
      try {
        const out = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(w[0] + 0.3), '-t', String(w[1] - 0.6), '-i', webms[0].f, '-vf', 'tblend=all_mode=difference,signalstats,metadata=print:file=-', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        const ys = [...out.matchAll(/YAVG=([\d.]+)/g)].map((m) => parseFloat(m[1])).slice(1);
        r[label].frameDiffMean = ys.length ? Math.round((ys.reduce((a, b) => a + b, 0) / ys.length) * 100) / 100 : null;
        r[label].frameDiffMax = ys.length ? Math.round(Math.max(...ys) * 100) / 100 : null;
        r[label].framesChanged = ys.filter((y) => y > 1.5).length;
        r[label].frames = ys.length;
      } catch (e) { r[label].ffmpegError = String((e as Error).message).slice(0, 100); }
    }
  }
  // re-derive issues (same rules as sweep.mts)
  const t = r.sitB && !r.sitB.error ? r.sitB : r.sitA;
  const issues: string[] = [];
  if (t && !t.error && r.ok) {
    const nav = !!r.gotoError && /about:blank|^$/.test(r.finalUrl || '');
    r.blocked = /just a moment|access denied|attention required|are you a human|verify you are|captcha|403|unusual traffic/i.test(t.title || '') || (t.text < 80 && !r.gotoError);
    r.navFailed = nav;
    if (!nav && !r.blocked) {
      const playing = (t.videos || []).filter((v: any) => !v.paused && !v.mark);
      if (playing.length) issues.push(`VIDEO playing x${playing.length}`);
      const infinite = (t.anims || []).filter((a: any) => a.iter === Infinity || a.iter === null);
      const finite = (t.anims || []).filter((a: any) => !(a.iter === Infinity || a.iter === null));
      if (infinite.length) issues.push(`ANIM infinite x${infinite.length}`);
      if (finite.length) issues.push(`anim finite x${finite.length}`);
      if (t.repeated && t.repeated.length) issues.push(`STROBE x${t.repeated.length}`);
      const rafps = t.raf / SIT_S, mutps = t.mut / SIT_S, drawps = t.draws / SIT_S;
      const visual = t.frameDiffMean != null && t.frameDiffMean >= 0.5;
      if (rafps >= 20 && mutps >= 5 && visual) issues.push(`JS-MOTION raf ${Math.round(rafps)}/s mut ${Math.round(mutps)}/s`);
      else if (rafps >= 20 || mutps >= 5) issues.push(`js-activity raf ${Math.round(rafps)}/s mut ${Math.round(mutps)}/s`);
      const unfrozen = (t.canvases || []).filter((c: any) => !c.still).length;
      if (drawps >= 30 && unfrozen) issues.push(`CANVAS drawing ${Math.round(drawps)}/s`);
      if (visual) issues.push(`VISUAL diff ${t.frameDiffMean} (${t.framesChanged}/${t.frames} frames)`);
      if (!t.stillOn) issues.push('still-not-on');
      if (!t.mwp) issues.push('main-world-missing');
    }
  }
  r.issues = issues;
  writeFileSync(rp, JSON.stringify(r, null, 1));
  results.push(r);
}
const sev = (r: any) => { if (r.error || r.blocked || r.navFailed) return -1; let s = 0; for (const i of r.issues) { if (/^VIDEO|^STROBE|^ANIM infinite/.test(i)) s += 10; else if (/^JS-MOTION|^CANVAS|^VISUAL/.test(i)) s += 5; else s += 1; } return s; };
results.sort((a, b) => sev(b) - sev(a) || a.host.localeCompare(b.host));
const lines = ['# Still motion sweep (reanalyzed)', '', `Sites: ${results.length}  Date: ${new Date().toISOString()}`, '', '| # | site | source | verdict | detail |', '|---|---|---|---|---|'];
results.forEach((r, i) => {
  const t = r.sitB && !r.sitB.error ? r.sitB : r.sitA; const detail: string[] = [];
  if (t && !t.error) {
    for (const v of (t.videos || []).filter((v: any) => !v.paused && !v.mark).slice(0, 2)) detail.push(`video ${v.d}`);
    for (const a of (t.anims || []).slice(0, 3)) detail.push(`${a.kind}${a.name ? ':' + a.name : ''}${a.iter === Infinity || a.iter === null ? '∞' : ''} ${a.where} ${a.el}`);
    for (const f of (t.repeated || []).slice(0, 2)) detail.push(`strobe ${f.d} ×${f.maxIn1500}/1.5s`);
    detail.push(`raf ${Math.round(t.raf / 4)}/s mut ${Math.round(t.mut / 4)}/s draws ${Math.round(t.draws / 4)}/s diff ${t.frameDiffMean ?? '-'} roots ${t.shadowRoots}`);
  }
  const verdict = r.error ? 'error' : r.navFailed ? 'unreachable' : r.blocked ? 'blocked' : (r.issues.length ? r.issues.join('; ') : 'clean');
  lines.push(`| ${i + 1} | ${r.host} | ${(r.src || []).join(',')} | ${verdict} | ${detail.join('<br>').replace(/\|/g, '/')} |`);
});
writeFileSync(join(dir, 'summary.md'), lines.join('\n'));
writeFileSync(join(dir, 'summary.json'), JSON.stringify(results, null, 1));
const counts: Record<string, number> = {};
for (const r of results) { const k = r.error ? 'error' : r.navFailed ? 'unreachable' : r.blocked ? 'blocked' : r.issues.length ? 'flagged' : 'clean'; counts[k] = (counts[k] || 0) + 1; }
console.log(JSON.stringify(counts));
for (const r of results) if (!r.error && !r.navFailed && !r.blocked && r.issues.length) console.log(r.host.padEnd(34), r.issues.join('; '));
