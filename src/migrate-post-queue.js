// migrate_post_queue.js
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  await pool.query(`
    UPDATE product_videos 
SET status = 'processing', 
    error_message = NULL, 
    created_at = NOW() 
WHERE status = 'failed'
  `);
  console.log('Migration applied — post_queue updated for multi-product carousels');
  await pool.end();
}
async function checkTime() {
  const result = await pool.query(`
    SELECT id, created_at, NOW() as current_db_time, (NOW() - created_at) as age_interval 
    FROM product_videos 
    WHERE status = 'failed' 
    ORDER BY created_at DESC 
    LIMIT 1;
  `);
  
  // result.rows is an array of your returned rows
  if (result.rows.length > 0) {
    console.log('--- Database Time Check ---');
    console.log(result.rows[0]);
  } else {
    console.log('No pending jobs found to check time.');
  }

  console.log('Migration applied — post_queue updated for multi-product carousels');
  await pool.end();
}
// checkTime()
migrate();