// schema.js
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function setupSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      brand TEXT,
      name TEXT,
      outfit_name TEXT NOT NULL,
      myntra_url TEXT NOT NULL,
      affiliate_link TEXT,
      price NUMERIC,
      original_price NUMERIC,
      discount TEXT,
      rating NUMERIC,
      rating_count INTEGER,
      sizes JSONB,
      description TEXT,
      category TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS product_images (
      id SERIAL PRIMARY KEY,
      product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
      image_url TEXT NOT NULL,
      quality_score INTEGER DEFAULT NULL,
      selected BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS post_queue (
      id SERIAL PRIMARY KEY,
      product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
      image_urls TEXT[] NOT NULL,
      caption TEXT,
      scheduled_for TIMESTAMP,
      status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'posted', 'failed')),
      posted_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_product_images_product_id ON product_images(product_id);
    CREATE INDEX IF NOT EXISTS idx_product_images_selected ON product_images(selected);
    CREATE INDEX IF NOT EXISTS idx_post_queue_status_scheduled ON post_queue(status, scheduled_for);
  `);
  console.log('Schema ready');
  await pool.end();
}

setupSchema();