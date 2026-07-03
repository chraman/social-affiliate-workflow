// migrate_post_queue.js
const { Pool } = require('pg');
require('dotenv').config();

const { Client } = require('pg');

async function runMigration() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL, // Ensure this is set
  });

  const sql = `
    -- Adds support for "combine picked clips into one video"
    ALTER TABLE product_videos 
    ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'magic_hour'; 

    ALTER TABLE product_videos 
    ADD COLUMN IF NOT EXISTS source_items JSONB;

    -- Ensure these columns are nullable
    ALTER TABLE product_videos 
    ALTER COLUMN magic_hour_project_id DROP NOT NULL;
    
    ALTER TABLE product_videos 
    ALTER COLUMN source_image_id DROP NOT NULL;
  `;

  try {
    await client.connect();
    console.log('Connected to database. Running migration...');
    
    await client.query(sql);
    
    console.log('Migration completed successfully.');
  } catch (err) {
    console.error('Migration failed:', err.stack);
  } finally {
    await client.end();
  }
}

runMigration();