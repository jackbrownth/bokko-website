#!/usr/bin/env node
/**
 * BOKKO — one-time conversion of the existing video library.
 *
 * Walks every project in Firestore, finds video files that browsers
 * struggle with (HEVC, QuickTime containers, no faststart, oversized),
 * re-encodes them to H.264 MP4, uploads the new file, and repoints the
 * Firestore record at it. Originals are left in place untouched.
 *
 * ── Setup ────────────────────────────────────────────────────────────
 *   1. Install ffmpeg
 *        macOS:    brew install ffmpeg
 *        Windows:  winget install Gyan.FFmpeg
 *   2. Firebase Console → Project settings → Service accounts
 *        → "Generate new private key" → save as service-account.json
 *          in the same folder as this script.
 *   3. npm install firebase-admin
 *
 * ── Run ──────────────────────────────────────────────────────────────
 *   node optimise-videos.js --dry            list what would change
 *   node optimise-videos.js --limit 3        do the first 3 (a safe trial)
 *   node optimise-videos.js                  do everything
 *
 * Safe to stop and re-run: anything already converted is skipped.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const admin = require('firebase-admin');

const BUCKET = 'bokko-6dc83.firebasestorage.app';

// A file is left alone if it is already all of these.
const TARGET_CODEC = 'h264';
const MAX_MB = 25;
const MAX_WIDTH = 1080;   // long edge for portrait, height for landscape

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const LIMIT = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1], 10) : Infinity;

const serviceAccountPath = path.join(__dirname, 'service-account.json');
if (!fs.existsSync(serviceAccountPath)) {
  console.error('Missing service-account.json — see the setup notes at the top of this file.');
  process.exit(1);
}
admin.initializeApp({
  credential: admin.credential.cert(require(serviceAccountPath)),
  storageBucket: BUCKET
});
const db = admin.firestore();
const bucket = admin.storage().bucket();

const run = (cmd, cmdArgs) => new Promise((resolve, reject) => {
  execFile(cmd, cmdArgs, { maxBuffer: 1024 * 1024 * 32 }, (err, stdout, stderr) => {
    if (err) reject(new Error(stderr || err.message));
    else resolve(stdout);
  });
});

async function probe(file) {
  const out = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,width,height',
    '-show_entries', 'format=format_name,size',
    '-of', 'json', file
  ]);
  const j = JSON.parse(out);
  const v = (j.streams && j.streams[0]) || {};
  return {
    codec: v.codec_name,
    width: v.width,
    height: v.height,
    container: (j.format && j.format.format_name) || '',
    sizeMB: (j.format && +j.format.size / 1048576) || 0
  };
}

// moov atom near the start = playback can begin before the file finishes downloading
function hasFaststart(file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(Math.min(262144, fs.statSync(file).size));
  fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  return buf.indexOf('moov') !== -1;
}

function needsWork(info, file) {
  const reasons = [];
  if (info.codec !== TARGET_CODEC) reasons.push(info.codec + ' video (needs H.264)');
  if (/mov|quicktime/i.test(info.container) && !/mp4/i.test(info.container)) reasons.push('QuickTime container');
  if (info.sizeMB > MAX_MB) reasons.push(Math.round(info.sizeMB) + 'MB');
  if (!hasFaststart(file)) reasons.push('no faststart');
  return reasons;
}

// Storage object path out of a firebasestorage download URL
function storagePathFromUrl(url) {
  const m = url.match(/\/o\/([^?]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

async function download(url, dest) {
  const objectPath = storagePathFromUrl(url);
  if (!objectPath) throw new Error('Could not read a storage path from the URL');
  await bucket.file(objectPath).download({ destination: dest });
  return objectPath;
}

async function transcode(src, dest, info) {
  const portrait = (info.height || 0) >= (info.width || 0);
  const scale = portrait ? `scale=${MAX_WIDTH}:-2` : `scale=-2:${MAX_WIDTH}`;
  await run('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', src,
    '-vf', `${scale},fps=30`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    dest
  ]);
}

async function upload(localFile, objectPath) {
  const token = crypto.randomUUID();
  await bucket.upload(localFile, {
    destination: objectPath,
    metadata: {
      contentType: 'video/mp4',
      cacheControl: 'public, max-age=31536000',
      metadata: { firebaseStorageDownloadTokens: token }
    }
  });
  return `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`;
}

(async function main() {
  const snap = await db.collection('projects').get();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bokko-'));
  let converted = 0, skipped = 0, failed = 0, savedMB = 0;

  console.log(`\n${snap.size} projects. ${DRY ? 'Dry run — nothing will change.\n' : ''}`);

  for (const doc of snap.docs) {
    const data = doc.data();
    const media = data.media || [];
    let touched = false;

    for (let i = 0; i < media.length; i++) {
      const m = media[i];
      if (m.type !== 'video' || !m.url) continue;
      if (m.optimised) { skipped++; continue; }
      if (converted >= LIMIT) break;

      const src = path.join(tmp, `src-${doc.id}-${i}`);
      const out = path.join(tmp, `out-${doc.id}-${i}.mp4`);
      const label = `${doc.id} [${i}]`;

      try {
        await download(m.url, src);
        const info = await probe(src);
        const reasons = needsWork(info, src);

        if (!reasons.length) {
          console.log(`  skip  ${label} — already fine (${info.codec}, ${Math.round(info.sizeMB)}MB)`);
          if (!DRY) { media[i].optimised = true; touched = true; }
          skipped++;
          fs.unlinkSync(src);
          continue;
        }

        console.log(`  fix   ${label} — ${reasons.join(', ')}`);
        if (DRY) { fs.unlinkSync(src); converted++; continue; }

        await transcode(src, out, info);
        const beforeMB = info.sizeMB;
        const afterMB = fs.statSync(out).size / 1048576;
        const objectPath = `projects/${doc.id}/video-h264-${Date.now()}-${i}.mp4`;
        media[i].url = await upload(out, objectPath);
        media[i].optimised = true;
        touched = true;
        converted++;
        savedMB += beforeMB - afterMB;
        console.log(`        ${Math.round(beforeMB)}MB → ${afterMB.toFixed(1)}MB`);

        fs.unlinkSync(src);
        fs.unlinkSync(out);
      } catch (err) {
        failed++;
        console.log(`  FAIL  ${label} — ${err.message}`);
        [src, out].forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
      }
    }

    if (touched && !DRY) {
      await doc.ref.update({ media });
      console.log(`  saved ${doc.id}`);
    }
    if (converted >= LIMIT) break;
  }

  console.log(`\nDone. converted: ${converted}  skipped: ${skipped}  failed: ${failed}`);
  if (savedMB > 0) console.log(`Storage and bandwidth saved: ~${Math.round(savedMB)}MB\n`);
  process.exit(0);
})();
