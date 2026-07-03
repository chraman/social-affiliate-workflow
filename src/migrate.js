const { Pool } = require('pg');
require('dotenv').config();
const { Client } = require('pg');

async function runMigration() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  const sql = `
    BEGIN;

    -- 1. Update product_videos table
    ALTER TABLE product_videos ADD COLUMN IF NOT EXISTS product_ids INTEGER[];

    -- 2. Backfill existing video product IDs
    UPDATE product_videos SET product_ids = ARRAY[product_id]::integer[]
    WHERE product_ids IS NULL AND product_id IS NOT NULL;

    -- 3. Create the new join table
    CREATE TABLE IF NOT EXISTS post_queue_item_products (
      id                  SERIAL PRIMARY KEY,
      post_queue_item_id  INTEGER NOT NULL REFERENCES post_queue_items(id) ON DELETE CASCADE,
      product_id          INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      display_order       INTEGER NOT NULL DEFAULT 1
    );

    -- 4. Create index for performance
    CREATE INDEX IF NOT EXISTS idx_pqip_item ON post_queue_item_products(post_queue_item_id);

    -- 5. Backfill existing queue items
    INSERT INTO post_queue_item_products (post_queue_item_id, product_id, display_order)
    SELECT id, product_id, 1 FROM post_queue_items
    WHERE product_id IS NOT NULL
    ON CONFLICT DO NOTHING;

    COMMIT;
  `;

  try {
    await client.connect();
    console.log('Starting migration...');
    
    await client.query(sql);
    
    console.log('Migration and backfill completed successfully.');
  } catch (err) {
    console.error('Migration failed. Rolling back:', err.stack);
  } finally {
    await client.end();
  }
}

runMigration();