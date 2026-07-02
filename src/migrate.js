const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  await pool.query(`
    ALTER TABLE post_queue
      ADD COLUMN IF NOT EXISTS ig_media_id TEXT,
      ADD COLUMN IF NOT EXISTS error_message TEXT;
  `);
  console.log('Migration applied — post_queue tracks ig_media_id and error_message');
  await pool.end();
}

migrate();