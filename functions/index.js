/**
 * BOKKO — automatic video optimisation.
 *
 * Runs on Cloud Run (Cloud Functions gen 2 is Cloud Run underneath, with a
 * one-command deploy instead of a Dockerfile). Fires whenever a video lands
 * in Firebase Storage, re-encodes it to web-standard H.264 MP4, uploads the
 * result and repoints the project record at it.
 *
 * Originals are never deleted.
 */

const { onObjectFinalized } = require('firebase-functions/v2/storage');
const { setGlobalOptions } = require('firebase-functions/v2');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

admin.initializeApp();
const db = admin.firestore();

const BUCKET = 'bokko-6dc83.firebasestorage.app';

/* A file is left alone if it is already all of these. */
const TARGET_CODEC = 'h264';
const MAX_MB = 25;
const LONG_EDGE = 1080;

setGlobalOptions({
  region: 'asia-southeast1',   // must match the Storage bucket's location
  memory: '4GiB',
  cpu: 2,
  timeoutSeconds: 540,
  maxInstances: 3              // keeps a bulk upload from fanning out
});

/* ------------------------------------------------------------------ utils */

const run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { maxBuffer: 1024 * 1024 * 32 }, (err, stdout, stderr) => {
    if (err) reject(new Error(stderr || err.message));
    else resolve(stdout);
  });
});

async function probe(file) {
  const out = await run(ffprobePath, [
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
    sizeMB: (j.format && Number(j.format.size) / 1048576) || 0
  };
}

/* moov atom near the front = playback starts before the download finishes */
function hasFaststart(file) {
  const size = fs.statSync(file).size;
  const len = Math.min(262144, size);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, 0);
  fs.closeSync(fd);
  return buf.indexOf('moov') !== -1;
}

function whatsWrong(info, file) {
  const reasons = [];
  if (info.codec !== TARGET_CODEC) reasons.push(`${info.codec} video`);
  if (/mov|quicktime/i.test(info.container) && !/mp4/i.test(info.container)) reasons.push('QuickTime container');
  if (info.sizeMB > MAX_MB) reasons.push(`${Math.round(info.sizeMB)}MB`);
  if (!hasFaststart(file)) reasons.push('no faststart');
  return reasons;
}

async function transcode(src, dest, info) {
  const portrait = (info.height || 0) >= (info.width || 0);
  const scale = portrait ? `scale=${LONG_EDGE}:-2` : `scale=-2:${LONG_EDGE}`;
  await run(ffmpegPath, [
    '-y', '-loglevel', 'error', '-i', src,
    '-vf', `${scale},fps=30`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    dest
  ]);
}

async function grabPoster(video, dest) {
  await run(ffmpegPath, [
    '-y', '-loglevel', 'error', '-ss', '1', '-i', video,
    '-frames:v', '1', '-vf', 'scale=720:-2', '-q:v', '4', dest
  ]);
}

async function uploadPublic(bucket, localFile, objectPath, contentType) {
  const token = crypto.randomUUID();
  await bucket.upload(localFile, {
    destination: objectPath,
    metadata: {
      contentType,
      cacheControl: 'public, max-age=31536000',
      metadata: { firebaseStorageDownloadTokens: token }
    }
  });
  return `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Swap the new URL into the project record.
 *
 * The admin panel uploads the file first and saves the document afterwards,
 * so on a fresh upload the record often doesn't exist yet — the admin page
 * picks the result up from the job document instead. We still try here, twice,
 * to cover files that were already saved (and re-runs).
 */
async function repointProject(originalPath, newUrl, posterUrl) {
  const projectId = originalPath.split('/')[1];
  if (!projectId) return false;
  const needle = encodeURIComponent(originalPath);

  for (let attempt = 0; attempt < 2; attempt++) {
    const ref = db.collection('projects').doc(projectId);
    const snap = await ref.get();
    if (snap.exists) {
      const media = (snap.data().media || []).slice();
      let hit = false;
      for (let i = 0; i < media.length; i++) {
        if (media[i].type === 'video' && typeof media[i].url === 'string' && media[i].url.indexOf(needle) !== -1) {
          media[i] = Object.assign({}, media[i], {
            url: newUrl,
            poster: media[i].poster || posterUrl || '',
            optimised: true
          });
          hit = true;
        }
      }
      if (hit) {
        await ref.update({ media });
        return true;
      }
    }
    if (attempt === 0) await sleep(8000);
  }
  return false;
}

/* ----------------------------------------------------------------- handler */

exports.optimiseVideo = onObjectFinalized({ bucket: BUCKET }, async (event) => {
  const filePath = event.data.name || '';
  const contentType = event.data.contentType || '';

  // Only project videos, and never our own output (that would loop forever).
  if (!filePath.startsWith('projects/')) return;
  if (filePath.includes('video-poster')) return;
  if (filePath.includes('video-h264')) return;

  const looksLikeVideo = contentType.startsWith('video/') ||
    /\.(mp4|mov|m4v|avi|mkv|webm)$/i.test(filePath);
  if (!looksLikeVideo) return;

  const jobId = filePath.replace(/\//g, '__');
  const jobRef = db.collection('videoJobs').doc(jobId);
  const bucket = admin.storage().bucket(BUCKET);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vid-'));
  const src = path.join(tmp, 'src');
  const out = path.join(tmp, 'out.mp4');
  const posterFile = path.join(tmp, 'poster.jpg');
  const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} };

  try {
    await jobRef.set({
      status: 'processing',
      path: filePath,
      startedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await bucket.file(filePath).download({ destination: src });
    const info = await probe(src);
    const reasons = whatsWrong(info, src);

    if (!reasons.length) {
      logger.info(`${filePath}: already fine (${info.codec}, ${Math.round(info.sizeMB)}MB)`);
      await jobRef.set({
        status: 'skipped',
        reason: 'already web-ready',
        beforeMB: Math.round(info.sizeMB),
        finishedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      cleanup();
      return;
    }

    logger.info(`${filePath}: converting — ${reasons.join(', ')}`);
    await transcode(src, out, info);

    const beforeMB = info.sizeMB;
    const afterMB = fs.statSync(out).size / 1048576;
    const stamp = Date.now();
    const base = filePath.replace(/^projects\//, '').split('/')[0];

    const newUrl = await uploadPublic(
      bucket, out, `projects/${base}/video-h264-${stamp}.mp4`, 'video/mp4'
    );

    // A poster the browser may have failed to produce (HEVC often can't be
    // decoded client-side), generated from the converted file instead.
    let posterUrl = '';
    try {
      await grabPoster(out, posterFile);
      posterUrl = await uploadPublic(
        bucket, posterFile, `projects/${base}/video-poster-auto-${stamp}.jpg`, 'image/jpeg'
      );
    } catch (e) {
      logger.warn(`${filePath}: poster generation skipped — ${e.message}`);
    }

    const swapped = await repointProject(filePath, newUrl, posterUrl);

    await jobRef.set({
      status: 'done',
      url: newUrl,
      poster: posterUrl,
      reasons,
      beforeMB: Math.round(beforeMB),
      afterMB: Math.round(afterMB * 10) / 10,
      recordUpdated: swapped,
      finishedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    logger.info(`${filePath}: ${Math.round(beforeMB)}MB -> ${afterMB.toFixed(1)}MB, record ${swapped ? 'updated' : 'pending admin save'}`);
    cleanup();

  } catch (err) {
    logger.error(`${filePath}: ${err.message}`);
    await jobRef.set({
      status: 'failed',
      error: err.message,
      finishedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true }).catch(() => {});
    cleanup();
  }
});
