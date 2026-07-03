const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const cloudinary = require('cloudinary').v2;
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ─── Magic Hour (image → video) config ────────────────────────────────────
const MAGIC_HOUR_API_KEY = process.env.MAGIC_HOUR_API_KEY;
const MAGIC_HOUR_BASE = 'https://api.magichour.ai/v1';
// NOTE: verify these against docs.magichour.ai before relying on them in prod —
// Magic Hour ships new models often and the model/resolution names below are current
// as of writing but not guaranteed to stay valid. Do one manual test call first.
const MAGIC_HOUR_MODEL = process.env.MAGIC_HOUR_MODEL || 'ltx-2.3';
const MAGIC_HOUR_RESOLUTION = process.env.MAGIC_HOUR_RESOLUTION || '720p';
const MAGIC_HOUR_DURATION_SECONDS = Number(process.env.MAGIC_HOUR_DURATION_SECONDS || 5);

// ─── Basic auth — required since this gets exposed via a public tunnel ───
const DASH_USER = process.env.DASH_USER || 'admin';
const DASH_PASS = process.env.DASH_PASS;

if (!DASH_PASS) {
  console.error('⚠️  DASH_PASS not set in .env — dashboard will run UNPROTECTED. Set DASH_PASS before tunneling.');
}

app.use((req, res, next) => {
  if (!DASH_PASS) return next(); // no password configured, skip (local-only use)

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Dashboard"');
    return res.status(401).send('Authentication required');
  }
  const [user, pass] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
  if (user === DASH_USER && pass === DASH_PASS) return next();

  res.set('WWW-Authenticate', 'Basic realm="Dashboard"');
  return res.status(401).send('Invalid credentials');
});

app.use(express.json());
app.use(express.static(require('path').join(__dirname, 'public')));

// ─── Cloudinary URL helpers ────────────────────────────────────────────────
// Cloudinary URLs look like:
//   https://res.cloudinary.com/<cloud>/image/upload/v169.../folder/sub/name.jpg
// public_id = "folder/sub/name" (no extension, no version segment)
function getPublicIdFromCloudinaryUrl(url) {
  try {
    const afterUpload = url.split('/upload/')[1];
    if (!afterUpload) return null;
    const parts = afterUpload.split('/');
    if (/^v\d+$/.test(parts[0])) parts.shift(); // drop version segment
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

// ─── Magic Hour helpers ─────────────────────────────────────────────────────
async function startImageToVideo(imageUrl, userPrompt) {
  const res = await axios.post(`${MAGIC_HOUR_BASE}/image-to-video`, {
    name: `VisionCraft video ${Date.now()}`,
    assets: { image_file_path: imageUrl },
    end_seconds: MAGIC_HOUR_DURATION_SECONDS,
    model: MAGIC_HOUR_MODEL,
    resolution: MAGIC_HOUR_RESOLUTION,
    style: {
      prompt: userPrompt || 'Subtle natural motion, fabric sway, gentle camera drift, no distortion'
    }
  }, {
    headers: {
      Authorization: `Bearer ${MAGIC_HOUR_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });
  return res.data.id;
}

// ─── Combine arbitrary clips (images + videos) into one video ────────────
// Runs locally via ffmpeg (ffmpeg-static bundles the binary, no system
// install needed) instead of chaining Cloudinary URL transformations —
// simpler to reason about for an arbitrary, user-picked list of clips.
const COMBINE_WIDTH = Number(process.env.COMBINE_WIDTH || 1080);
const COMBINE_HEIGHT = Number(process.env.COMBINE_HEIGHT || 1350);
const COMBINE_FPS = Number(process.env.COMBINE_FPS || 30);
const COMBINE_IMAGE_HOLD_SECONDS = Number(process.env.COMBINE_IMAGE_HOLD_SECONDS || 3);

async function downloadToFile(url, destPath) {
  const writer = fs.createWriteStream(destPath);
  const response = await axios.get(url, { responseType: 'stream' });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

function probeDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      resolve(data.format.duration);
    });
  });
}

// Scales/pads every clip to the same size+fps (required for xfade), then
// chains a cross-fade between each consecutive pair. Works the same way
// whether there are 2 clips or 8 — no manual layer nesting.
function buildScaleAndXfadeFilter(clips, transitionDuration) {
  const scaleParts = clips.map((c, i) =>
    `[${i}:v]scale=${COMBINE_WIDTH}:${COMBINE_HEIGHT}:force_original_aspect_ratio=decrease,` +
    `pad=${COMBINE_WIDTH}:${COMBINE_HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${COMBINE_FPS}[s${i}]`
  );

  const xfadeParts = [];
  let lastLabel = 's0';
  let cumulative = clips[0].duration;
  for (let i = 1; i < clips.length; i++) {
    const outLabel = i === clips.length - 1 ? 'vout' : `x${i}`;
    // each transition eats `transitionDuration` seconds from the running total
    const offset = Math.max(cumulative - transitionDuration, 0.1);
    xfadeParts.push(
      `[${lastLabel}][s${i}]xfade=transition=fade:duration=${transitionDuration}:offset=${offset.toFixed(2)}[${outLabel}]`
    );
    lastLabel = outLabel;
    cumulative = offset + clips[i].duration;
  }

  return { filter: [...scaleParts, ...xfadeParts].join(';'), outputLabel: lastLabel };
}

// Runs in the background — the caller responds immediately and the frontend
// polls /api/videos for the status flip, same pattern as Magic Hour jobs.
async function runCombineJob(videoRowId, items, transitionDuration) {
  const jobDir = path.join(os.tmpdir(), `combine_${videoRowId}_${crypto.randomBytes(4).toString('hex')}`);
  await fsp.mkdir(jobDir, { recursive: true });

  try {
    const clips = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const ext = item.media_type === 'VIDEO' ? 'mp4' : 'jpg';
      const localPath = path.join(jobDir, `in_${i}.${ext}`);
      await downloadToFile(item.image_url, localPath);
      const duration = item.media_type === 'VIDEO'
        ? await probeDuration(localPath)
        : Number(item.duration || COMBINE_IMAGE_HOLD_SECONDS);
      clips.push({ path: localPath, media_type: item.media_type, duration });
    }

    const { filter, outputLabel } = buildScaleAndXfadeFilter(clips, transitionDuration);
    const outputPath = path.join(jobDir, 'output.mp4');

    await new Promise((resolve, reject) => {
      const cmd = ffmpeg();
      clips.forEach(c => {
        if (c.media_type === 'IMAGE') {
          cmd.input(c.path).inputOptions(['-loop 1', `-t ${c.duration}`]);
        } else {
          cmd.input(c.path);
        }
      });
      cmd
        .complexFilter(filter, outputLabel)
        // audio is dropped for simplicity — fine for silent AI-generated motion
        // clips, but flag it if you start combining clips that have real audio
        .outputOptions(['-an', '-c:v libx264', '-pix_fmt yuv420p', '-movflags +faststart'])
        .output(outputPath)
        .on('error', reject)
        .on('end', resolve)
        .run();
    });

    // Upload into the same Cloudinary folder as the first source clip
    const folder = getFolderFromCloudinaryUrl(items[0].image_url);
    const uploadResult = await cloudinary.uploader.upload(outputPath, {
      resource_type: 'video',
      folder: folder || undefined,
      public_id: `combined_${videoRowId}`,
      overwrite: false
    });

    await pool.query(
      `UPDATE product_videos SET status = 'ready', video_url = $1, cloudinary_public_id = $2, updated_at = NOW() WHERE id = $3`,
      [uploadResult.secure_url, uploadResult.public_id, videoRowId]
    );
    console.log(`✅ Combined video #${videoRowId} ready → ${uploadResult.secure_url}`);
  } catch (err) {
    console.error(`❌ Combine job #${videoRowId} failed:`, err.message);
    await pool.query(
      `UPDATE product_videos SET status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2`,
      [err.message, videoRowId]
    );
  } finally {
    fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ─── Get all categories that have images available ───────────────────────
app.get('/api/categories', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT COALESCE(NULLIF(p.category, ''), 'uncategorized') AS category, 
        COUNT(DISTINCT pi.id) AS image_count
      FROM products p
      JOIN product_images pi ON pi.product_id = p.id
      GROUP BY COALESCE(NULLIF(p.category, ''), 'uncategorized')
      ORDER BY category
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Get all images for a given category, grouped by product ─────────────
app.get('/api/images', async (req, res) => {
  const { category } = req.query;
  try {
    const result = await pool.query(`
      SELECT 
        p.id AS product_id, p.outfit_name, p.brand, p.name, p.price, 
        p.affiliate_link, p.category,
        pi.id AS image_id, pi.image_url, pi.quality_score, pi.selected
      FROM products p
      JOIN product_images pi ON pi.product_id = p.id
      WHERE ($1::text IS NULL OR $1 = '' OR COALESCE(NULLIF(p.category, ''), 'uncategorized') = $1)
      ORDER BY p.id DESC, pi.id ASC
    `, [category || null]);

    // group by product
    const grouped = {};
    for (const row of result.rows) {
      if (!grouped[row.product_id]) {
        grouped[row.product_id] = {
          product_id: row.product_id,
          outfit_name: row.outfit_name,
          brand: row.brand,
          name: row.name,
          price: row.price,
          affiliate_link: row.affiliate_link,
          category: row.category,
          images: []
        };
      }
      grouped[row.product_id].images.push({
        image_id: row.image_id,
        image_url: row.image_url,
        quality_score: row.quality_score,
        selected: row.selected
      });
    }
    res.json(Object.values(grouped));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/videos/grouped', async (req, res) => {
  const { category } = req.query;
  try {
    const result = await pool.query(`
      SELECT 
        p.id AS product_id, p.outfit_name, p.brand, p.name, p.price, 
        p.affiliate_link, p.category,
        v.id AS video_id, v.source_image_url, v.video_url, v.status, 
        v.cloudinary_public_id, v.prompt, v.error_message, v.created_at
      FROM products p
      JOIN product_videos v ON v.product_id = p.id
      WHERE ($1::text IS NULL OR $1 = '' OR COALESCE(NULLIF(p.category, ''), 'uncategorized') = $1)
      ORDER BY p.id DESC, v.created_at DESC
    `, [category || null]);

    // Grouping by product
    const grouped = {};
    for (const row of result.rows) {
      if (!grouped[row.product_id]) {
        grouped[row.product_id] = {
          product_id: row.product_id,
          outfit_name: row.outfit_name,
          brand: row.brand,
          name: row.name,
          price: row.price,
          affiliate_link: row.affiliate_link,
          category: row.category,
          generated_videos: [] // Renamed for clarity
        };
      }
      
      // Add the video-specific data to the product's list
      grouped[row.product_id].generated_videos.push({
        video_id: row.video_id,
        source_image_url: row.source_image_url,
        video_url: row.video_url,
        status: row.status,
        cloudinary_public_id: row.cloudinary_public_id,
        prompt: row.prompt,
        error_message: row.error_message,
        created_at: row.created_at
      });
    }
    
    res.json(Object.values(grouped));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});
// ─── Rate / mark an image selected (used for quality review, optional) ───
app.post('/api/images/:imageId/rate', async (req, res) => {
  const { imageId } = req.params;
  const { quality_score, selected } = req.body;
  try {
    await pool.query(
      `UPDATE product_images SET quality_score = $1, selected = $2 WHERE id = $3`,
      [quality_score ?? null, selected ?? false, imageId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete an image (DB row + best-effort Cloudinary cleanup) ───────────
app.delete('/api/images/:imageId', async (req, res) => {
  const { imageId } = req.params;
  try {
    const imgRes = await pool.query(`SELECT image_url FROM product_images WHERE id = $1`, [imageId]);
    if (imgRes.rows.length === 0) return res.status(404).json({ error: 'Image not found' });
    const imageUrl = imgRes.rows[0].image_url;

    // Block delete if the image is referenced by a queued (not-yet-posted) post,
    // to avoid the worker publishing a dead URL.
    const inUse = await pool.query(
      `SELECT 1 FROM post_queue_items pqi
       JOIN post_queue pq ON pq.id = pqi.post_queue_id
       WHERE pqi.image_id = $1 AND pq.status = 'pending' LIMIT 1`,
      [imageId]
    );
    if (inUse.rows.length > 0) {
      return res.status(409).json({ error: 'This image is in a pending queued post. Remove it from the queue first.' });
    }

    await pool.query(`UPDATE post_queue_items SET image_id = NULL WHERE image_id = $1`, [imageId]);

    await pool.query(`DELETE FROM product_images WHERE id = $1`, [imageId]);

    if (process.env.CLOUDINARY_CLOUD_NAME && imageUrl && imageUrl.includes('res.cloudinary.com')) {
      try {
        const publicId = getPublicIdFromCloudinaryUrl(imageUrl);
        if (publicId) await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
      } catch (cloudErr) {
        // DB row is already gone — log and move on rather than failing the request
        console.error('Cloudinary delete failed (DB row already removed):', cloudErr.message);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Kick off an image→video job via Magic Hour ───────────────────────────
app.post('/api/videos/generate', async (req, res) => {
  const { image_id, product_id, image_url, prompt } = req.body;
  if (!image_id || !image_url || !product_id) {
    return res.status(400).json({ error: 'image_id, product_id and image_url are required' });
  }
  if (!MAGIC_HOUR_API_KEY) {
    return res.status(500).json({ error: 'MAGIC_HOUR_API_KEY not configured on the server' });
  }
  try {
    const projectId = await startImageToVideo(image_url, prompt);
    const insertRes = await pool.query(
      `INSERT INTO product_videos (product_id, source_image_id, source_image_url, magic_hour_project_id, status, prompt, product_ids)
       VALUES ($1, $2, $3, $4, 'processing', $5, ARRAY[$1]::integer[]) RETURNING id`,
      [product_id, image_id, image_url, projectId, prompt || null]
    );
    res.json({ ok: true, video_id: insertRes.rows[0].id, magic_hour_project_id: projectId });
  } catch (err) {
    console.error('Magic Hour start error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// ─── Combine an ordered list of picked images/videos into one video ──────
app.post('/api/videos/combine', async (req, res) => {
  const { items, transition_duration } = req.body;
  // items: [{ media_type: 'IMAGE'|'VIDEO', image_url, product_id, duration? }] in play order

  if (!items || items.length < 2) {
    return res.status(400).json({ error: 'Pick at least 2 clips to combine' });
  }
  const transitionDuration = Number(transition_duration) > 0 ? Number(transition_duration) : 1;
  // every distinct product represented in the clips being combined, in first-seen order
  const productIds = [...new Set(items.map(i => i.product_id).filter(Boolean))];

  try {
    const insertRes = await pool.query(
      `INSERT INTO product_videos (product_id, source_image_url, status, source_type, source_items, product_ids)
       VALUES ($1, $2, 'processing', 'combined', $3, $4) RETURNING id`,
      [productIds[0] || null, items[0].image_url, JSON.stringify(items), productIds]
    );
    const videoRowId = insertRes.rows[0].id;

    // respond immediately — the frontend polls /api/videos for the status flip
    res.json({ ok: true, video_id: videoRowId });

    runCombineJob(videoRowId, items, transitionDuration);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── List generated videos (for the Videos tab) ───────────────────────────
app.get('/api/videos', async (req, res) => {
  const { status } = req.query;
  try {
    const result = await pool.query(`
      SELECT v.*, p.outfit_name, p.brand, p.name, p.affiliate_link, p.category
      FROM product_videos v
      JOIN products p ON p.id = v.product_id
      WHERE ($1::text IS NULL OR $1 = '' OR v.status = $1)
      ORDER BY v.created_at DESC
    `, [status || null]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete a video (DB row + best-effort Cloudinary cleanup) ────────────
app.delete('/api/videos/:id', async (req, res) => {
  try {
    const vRes = await pool.query(`SELECT cloudinary_public_id FROM product_videos WHERE id = $1`, [req.params.id]);
    if (vRes.rows.length === 0) return res.status(404).json({ error: 'Not found' });

    const inUse = await pool.query(
      `SELECT 1 FROM post_queue_items pqi
       JOIN post_queue pq ON pq.id = pqi.post_queue_id
       WHERE pqi.video_id = $1 AND pq.status = 'pending' LIMIT 1`,
      [req.params.id]
    );
    if (inUse.rows.length > 0) {
      return res.status(409).json({ error: 'This video is in a pending queued post. Remove it from the queue first.' });
    }

    const publicId = vRes.rows[0].cloudinary_public_id;
    await pool.query(`DELETE FROM product_videos WHERE id = $1`, [req.params.id]);

    if (publicId) {
      try { await cloudinary.uploader.destroy(publicId, { resource_type: 'video' }); }
      catch (e) { console.error('Cloudinary video delete failed (DB row already removed):', e.message); }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Create a post (single/carousel image and/or video items) ────────────
app.post('/api/queue', async (req, res) => {
  const { items, caption, scheduled_for } = req.body;
  // items: [{ product_id, image_id, video_id, image_url, media_type, position }]
  // media_type per item: 'IMAGE' | 'VIDEO'

  if (!items || items.length === 0) {
    return res.status(400).json({ error: 'No items selected' });
  }

  const hasVideo = items.some(i => i.media_type === 'VIDEO');
  const postMediaType = items.length === 1 ? (hasVideo ? 'REELS' : 'IMAGE') : 'CAROUSEL';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const imageUrls = items.map(i => i.image_url);

    const postResult = await client.query(
      `INSERT INTO post_queue (image_urls, caption, scheduled_for, status, media_type)
       VALUES ($1, $2, $3::timestamp AT TIME ZONE 'Asia/Kolkata', 'pending', $4) RETURNING id`,
      [imageUrls, caption, scheduled_for, postMediaType]
    );
    const postQueueId = postResult.rows[0].id;

    for (const item of items) {
      const isVideo = item.media_type === 'VIDEO';
      const insertItemRes = await client.query(
        `INSERT INTO post_queue_items (post_queue_id, product_id, image_id, video_id, position, media_type)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [postQueueId, item.product_id, isVideo ? null : item.image_id, isVideo ? item.video_id : null, item.position, item.media_type || 'IMAGE']
      );
      const queueItemId = insertItemRes.rows[0].id;

      // A video item may represent several products (a combined video);
      // an image item always represents exactly one. Either way, every
      // product this item should give out a link for goes into this table —
      // it's what the IG webhook reads from when someone asks "link".
      let productIdsForItem = [item.product_id].filter(Boolean);
      if (isVideo && item.video_id) {
        const vidRes = await client.query(
          `SELECT product_ids, product_id FROM product_videos WHERE id = $1`,
          [item.video_id]
        );
        if (vidRes.rows.length > 0) {
          const row = vidRes.rows[0];
          productIdsForItem = (row.product_ids && row.product_ids.length > 0)
            ? row.product_ids
            : [row.product_id].filter(Boolean);
        }
      }

      let displayOrder = 1;
      for (const pid of productIdsForItem) {
        await client.query(
          `INSERT INTO post_queue_item_products (post_queue_item_id, product_id, display_order) VALUES ($1, $2, $3)`,
          [queueItemId, pid, displayOrder++]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ ok: true, post_queue_id: postQueueId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─── List queued/scheduled posts ──────────────────────────────────────────
app.get('/api/queue', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT pq.id, pq.image_urls, pq.caption, pq.scheduled_for, pq.status, pq.posted_at, pq.media_type,
        COALESCE(json_agg(json_build_object(
          'product_id', p.id, 'outfit_name', p.outfit_name, 
          'affiliate_link', p.affiliate_link, 'position', pqi.position,
          'media_type', pqi.media_type
        )) FILTER (WHERE p.id IS NOT NULL), '[]') AS products
      FROM post_queue pq
      LEFT JOIN post_queue_items pqi ON pqi.post_queue_id = pq.id
      LEFT JOIN products p ON p.id = pqi.product_id
      GROUP BY pq.id
      ORDER BY pq.scheduled_for ASC NULLS LAST, pq.id DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete a queued post (before it's posted) ────────────────────────────
app.delete('/api/queue/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM post_queue WHERE id = $1 AND status = 'pending'`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Dashboard running:`);
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Network: http://<your-laptop-ip>:${PORT}  (open this on your phone)\n`);
  console.log(`   Find your laptop IP with: ifconfig (Mac/Linux) or ipconfig (Windows)\n`);
});