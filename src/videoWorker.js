const { Pool } = require('pg');
const axios = require('axios');
const cloudinary = require('cloudinary').v2;
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const MAGIC_HOUR_API_KEY = process.env.MAGIC_HOUR_API_KEY;
const MAGIC_HOUR_BASE = 'https://api.magichour.ai/v1';

const LTX_API_KEY = process.env.LTX_API_KEY;
const LTX_BASE = 'https://api.ltx.io/v2';

// How long to keep polling a single job before giving up and marking it failed.
const MAX_JOB_AGE_MS = 6 * 60 * 60 * 1000; // 30 min

// ─── Cloudinary URL helpers (duplicated from server.js — see note there) ──
function getPublicIdFromCloudinaryUrl(url) {
  try {
    const afterUpload = url.split('/upload/')[1];
    if (!afterUpload) return null;
    const parts = afterUpload.split('/');
    if (/^v\d+$/.test(parts[0])) parts.shift();
    const last = parts.pop();
    const noExt = last.replace(/\.[a-zA-Z0-9]+$/, '');
    return [...parts, noExt].join('/');
  } catch {
    return null;
  }
}

function getFolderFromCloudinaryUrl(url) {
  const publicId = getPublicIdFromCloudinaryUrl(url);
  if (!publicId || !publicId.includes('/')) return null;
  return publicId.split('/').slice(0, -1).join('/');
}

// ─── Magic Hour status check ────────────────────────────────────────────────
// NOTE: verify this path (GET /v1/video-projects/:id) against docs.magichour.ai —
// it's what their "Get video details" endpoint maps to as of writing, but confirm
// with one manual call before trusting this in production.
async function checkVideoStatus(projectId) {
  const res = await axios.get(`${MAGIC_HOUR_BASE}/video-projects/${projectId}`, {
    headers: { Authorization: `Bearer ${MAGIC_HOUR_API_KEY}` }
  });
  return res.data; // expect { status: 'complete'|'error'|'processing'|..., downloads: [{ url }], error }
}

async function checkVideoStatusUsingLTX(jobId) {
  const res = await axios.get(`${LTX_BASE}/image-to-video/${jobId}`, {
    headers: { Authorization: `Bearer ${LTX_API_KEY}` }
  });
  return res.data; // { id, status: 'pending'|'processing'|'completed'|'failed', result: { video_url }, error, created_at, completed_at }
}

async function handleCompletedJob(job, downloadUrl) {
  const folder = getFolderFromCloudinaryUrl(job.source_image_url);
  const baseName = getPublicIdFromCloudinaryUrl(job.source_image_url)?.split('/').pop() || `video_${job.id}`;

  // Cloudinary will fetch the remote Magic Hour URL directly — no need to
  // download it to disk ourselves.
  const uploadResult = await cloudinary.uploader.upload(downloadUrl, {
    resource_type: 'video',
    folder: folder || undefined,
    public_id: `${baseName}_motion_${job.id}`,
    overwrite: false
  });

  await pool.query(
    `UPDATE product_videos
     SET status = 'ready', video_url = $1, cloudinary_public_id = $2, updated_at = NOW()
     WHERE id = $3`,
    [uploadResult.secure_url, uploadResult.public_id, job.id]
  );
  console.log(`  ✅ Video #${job.id} ready → ${uploadResult.secure_url}`);
}

async function processVideoJobs() {
  const pending = await pool.query(
    `SELECT * FROM product_videos WHERE status = 'processing' ORDER BY created_at ASC`
  );

  if (pending.rows.length === 0) {
    console.log(`[${new Date().toLocaleTimeString()}] No video jobs pending.`);
    return;
  }

  for (const job of pending.rows) {
    const now = new Date();
    const nowUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 
                            now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds());

    const jobDate = new Date(job.created_at);
    const jobUtc = Date.UTC(jobDate.getUTCFullYear(), jobDate.getUTCMonth(), jobDate.getUTCDate(), 
                            jobDate.getUTCHours(), jobDate.getUTCMinutes(), jobDate.getUTCSeconds());

    const ageMs = nowUtc - jobUtc;
    console.log(ageMs, MAX_JOB_AGE_MS, nowUtc, jobUtc, jobDate)
    if (ageMs > MAX_JOB_AGE_MS) {
      console.error(`  ⏱️  Video #${job.id} timed out after ${Math.round(ageMs / 60000)} min`);
      await pool.query(
        `UPDATE product_videos SET status = 'failed', error_message = 'Timed out waiting for Magic Hour', updated_at = NOW() WHERE id = $1`,
        [job.id]
      );
      continue;
    }

    if (!job.magic_hour_project_id) continue;

    try {
      const data = await checkVideoStatusUsingLTX(job.magic_hour_project_id);
      console.log(data)
      const status = (data.status || '').toLowerCase();

      if (status === 'complete' || status === 'completed') {
        const downloadUrl = data.result?.video_url || data.downloads?.[0]?.url; 
        if (!downloadUrl) {
          throw new Error('Magic Hour reported complete but returned no download URL');
        }
        await handleCompletedJob(job, downloadUrl);
      } else if (status === 'error' || status === 'canceled' || status === 'cancelled') {
        const errMsg = data.error?.message || data.error || 'Magic Hour job failed';
        console.error(`  ❌ Video #${job.id} failed: ${errMsg}`);
        await pool.query(
          `UPDATE product_videos SET status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2`,
          [errMsg, job.id]
        );
      } else {
        console.log(`  ⏳ Video #${job.id} still ${status || 'processing'}...`);
      }
    } catch (err) {
      const errMsg = err.response?.data?.message || err.message;
      console.error(`  ❌ Error checking video #${job.id}: ${errMsg}`);
      // Don't mark as failed on a transient network/API error — just retry next tick,
      // unless it's been retrying past MAX_JOB_AGE_MS (handled above).
    }
  }
}

// Poll every minute — matches the cadence of ig-worker.js
const INTERVAL_MS = 60 * 1000;
console.log('🎬 Magic Hour video worker started. Checking every 1 min.');
processVideoJobs();
setInterval(processVideoJobs, INTERVAL_MS);