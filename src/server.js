const express = require('express');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

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

// ─── Create a post (single or multi-product carousel) ────────────────────
app.post('/api/queue', async (req, res) => {
  const { items, caption, scheduled_for } = req.body;
  // items: [{ product_id, image_id, image_url, position }]

  if (!items || items.length === 0) {
    return res.status(400).json({ error: 'No images selected' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const imageUrls = items.map(i => i.image_url);

    const postResult = await client.query(
      `INSERT INTO post_queue (image_urls, caption, scheduled_for, status)
       VALUES ($1, $2, $3::timestamp AT TIME ZONE 'Asia/Kolkata', 'pending') RETURNING id`,
      [imageUrls, caption, scheduled_for]
    );
    const postQueueId = postResult.rows[0].id;

    for (const item of items) {
      await client.query(
        `INSERT INTO post_queue_items (post_queue_id, product_id, image_id, position)
         VALUES ($1, $2, $3, $4)`,
        [postQueueId, item.product_id, item.image_id, item.position]
      );
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
      SELECT pq.id, pq.image_urls, pq.caption, pq.scheduled_for, pq.status, pq.posted_at,
        COALESCE(json_agg(json_build_object(
          'product_id', p.id, 'outfit_name', p.outfit_name, 
          'affiliate_link', p.affiliate_link, 'position', pqi.position
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
})
const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Dashboard running:`);
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Network: http://<your-laptop-ip>:${PORT}  (open this on your phone)\n`);
  console.log(`   Find your laptop IP with: ifconfig (Mac/Linux) or ipconfig (Windows)\n`);
});