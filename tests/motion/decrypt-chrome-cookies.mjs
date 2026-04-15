#!/usr/bin/env node
// Read Chrome cookies for a given domain, decrypt with the macOS Keychain
// "Chrome Safe Storage" password, and emit a Playwright-compatible JSON array.
//
// Usage: node decrypt-chrome-cookies.mjs --profile "Profile 3" --domain amazon.com --out cookies.json
//
// On first run macOS will prompt via Keychain to grant `security` access to
// the Safe Storage entry — click "Always Allow".

import { execFileSync } from 'node:child_process';
import { copyFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { pbkdf2Sync, createDecipheriv } from 'node:crypto';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const profile = arg('profile', 'Profile 3');
const domain = arg('domain', 'amazon.com');
const outPath = arg('out', 'cookies.json');

const cookiesSrc = join(homedir(), 'Library/Application Support/Google/Chrome', profile, 'Cookies');

// Copy the SQLite file to avoid touching the live one.
const tmp = mkdtempSync(join(tmpdir(), 'chrome-cookies-'));
const cookiesCopy = join(tmp, 'Cookies');
copyFileSync(cookiesSrc, cookiesCopy);

// Pull the Safe Storage password from Keychain (prompts GUI once).
const pw = execFileSync('security', ['find-generic-password', '-s', 'Chrome Safe Storage', '-w'], { encoding: 'utf8' }).trim();

// Chrome on macOS derives the AES-128-CBC key via PBKDF2-HMAC-SHA1,
// salt='saltysalt', iterations=1003, keyLen=16.
const key = pbkdf2Sync(pw, 'saltysalt', 1003, 16, 'sha1');
const iv = Buffer.alloc(16, 0x20); // 16 spaces

function decrypt(buf) {
  if (buf.length < 3) return null;
  const prefix = buf.slice(0, 3).toString();
  if (prefix !== 'v10') {
    // v11+ (Linux GNOME) or v20 (newer macOS app-bound) — not handled here.
    return { unsupported: prefix };
  }
  const ct = buf.slice(3);
  const decipher = createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(true);
  try {
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    // Newer Chrome prepends a 32-byte SHA-256 of the hostname to the plaintext.
    // If the first 32 bytes are non-printable, strip them.
    if (pt.length > 32 && pt[0] < 0x20) return pt.slice(32).toString('utf8');
    return pt.toString('utf8');
  } catch (e) {
    return { error: e.message };
  }
}

// Query cookies for the domain (and its subdomains via leading-dot match).
const rowsJson = execFileSync('sqlite3', [
  cookiesCopy,
  '-json',
  `SELECT host_key, name, path, expires_utc, is_secure, is_httponly, samesite,
          hex(encrypted_value) AS enc_hex, value AS plain
   FROM cookies
   WHERE host_key LIKE '%${domain}%';`,
], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });

const rows = rowsJson.trim() ? JSON.parse(rowsJson) : [];

const cookies = [];
const skipped = [];
for (const r of rows) {
  const enc = Buffer.from(r.enc_hex, 'hex');
  let value = r.plain || '';
  if (enc.length > 0) {
    const out = decrypt(enc);
    if (typeof out === 'string') value = out;
    else { skipped.push({ name: r.name, reason: out }); continue; }
  }
  // Chrome epoch: microseconds since 1601-01-01. Convert to Unix seconds.
  const CHROME_EPOCH_OFFSET = 11644473600; // seconds between 1601-01-01 and 1970-01-01
  const expires = r.expires_utc ? Math.floor(r.expires_utc / 1_000_000) - CHROME_EPOCH_OFFSET : -1;
  const sameSiteMap = { '-1': 'None', '0': 'None', '1': 'Lax', '2': 'Strict' };
  cookies.push({
    name: r.name,
    value,
    domain: r.host_key,
    path: r.path || '/',
    expires,
    httpOnly: !!r.is_httponly,
    secure: !!r.is_secure,
    sameSite: sameSiteMap[String(r.samesite)] || 'Lax',
  });
}

writeFileSync(outPath, JSON.stringify(cookies, null, 2));
console.error(`wrote ${cookies.length} cookies to ${outPath} (skipped ${skipped.length})`);
if (skipped.length) console.error('skipped:', JSON.stringify(skipped.slice(0, 5)));
