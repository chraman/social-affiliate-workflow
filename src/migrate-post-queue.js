// migrate_post_queue.js
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  await pool.query(`
    ALTER TABLE post_queue DROP COLUMN IF EXISTS product_id;

    CREATE TABLE IF NOT EXISTS post_queue_items (
      id SERIAL PRIMARY KEY,
      post_queue_id INTEGER REFERENCES post_queue(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id),
      image_id INTEGER REFERENCES product_images(id),
      position INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_post_queue_items_post_queue_id ON post_queue_items(post_queue_id);
    CREATE INDEX IF NOT EXISTS idx_post_queue_items_product_id ON post_queue_items(product_id);
  `);
  console.log('Migration applied — post_queue updated for multi-product carousels');
  await pool.end();
}

migrate();