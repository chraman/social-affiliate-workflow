// migrate_post_queue.js
const { Pool } = require('pg');
require('dotenv').config();

const { Client } = require('pg');

async function runMigration() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL, // Ensure this is set
  });

  const sql = `ALTER TABLE post_queue ADD COLUMN IF NOT EXISTS post_type TEXT NOT NULL DEFAULT 'FEED'
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