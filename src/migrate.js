const { Pool } = require('pg');
require('dotenv').config();
// Configure your connection string via environment variables
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log('Starting migration...');
    await client.query('BEGIN');

    // 1. Create table
    await client.query(`
      CREATE TABLE IF NOT EXISTS product_videos (
        id SERIAL PRIMARY KEY,
        product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
        source_image_id INTEGER REFERENCES product_images(id) ON DELETE SET NULL,
        source_image_url TEXT NOT NULL,
        magic_hour_project_id TEXT,
        status TEXT NOT NULL DEFAULT 'processing',
        video_url TEXT,
        cloudinary_public_id TEXT,
        prompt TEXT,
        error_message TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // 2. Create index
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_product_videos_status ON product_videos(status);
    `);

    // 3. Alter post_queue
    await client.query(`
      ALTER TABLE post_queue ADD COLUMN IF NOT EXISTS media_type TEXT DEFAULT 'IMAGE';
    `);

    // 4. Alter post_queue_items
    await client.query(`
      ALTER TABLE post_queue_items ADD COLUMN IF NOT EXISTS media_type TEXT DEFAULT 'IMAGE';
      ALTER TABLE post_queue_items ADD COLUMN IF NOT EXISTS video_id INTEGER REFERENCES product_videos(id) ON DELETE SET NULL;
      ALTER TABLE post_queue_items ALTER COLUMN image_id DROP NOT NULL;
    `);

    await client.query('COMMIT');
    console.log('Migration applied successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed, transaction rolled back:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration();