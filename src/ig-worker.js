const { Pool } = require('pg');
const axios = require('axios');
require('dotenv').config();
// Add request logging
axios.interceptors.request.use(request => {
  console.log(`[${new Date().toISOString()}] 📤 API Request:`, {
    url: request.url,
    method: request.method,
    params: request.params
  });
  return request;
});

// Add response logging
axios.interceptors.response.use(
  response => {
    console.log(`[${new Date().toISOString()}] ✅ API Response:`, {
      status: response.status,
      data: response.data
    });
    return response;
  },
  error => {
    // Log detailed error information
    console.error(`[${new Date().toISOString()}] ❌ API Error:`, {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data // This will show the specific Meta/Instagram error
    });
    return Promise.reject(error);
  }
);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const IG_USER_ID = process.env.IG_USER_ID;        // your Instagram Business account ID
const IG_TOKEN = process.env.IG_ACCESS_TOKEN;      // long-lived Page access token
const GRAPH_API = 'https://graph.facebook.com/v25.0';

async function createMediaContainer(imageUrl, isCarouselItem) {
  const res = await axios.post(`${GRAPH_API}/${IG_USER_ID}/media`, {
        image_url: imageUrl
    }, {
        headers: {
        'Authorization': `Bearer ${IG_TOKEN}`
        }
    });
  return res.data.id;
}

async function createCarouselContainer(childIds, caption) {
  const res = await axios.post(`${GRAPH_API}/${IG_USER_ID}/media`, {
      media_type: 'CAROUSEL',
      children: childIds.join(','),
      caption: caption
    }, {
        headers: {
        'Authorization': `Bearer ${IG_TOKEN}`
        }
    });
  return res.data.id;
}

async function createSingleContainer(imageUrl, caption) {
  const res = await axios.post(`${GRAPH_API}/${IG_USER_ID}/media`, {
      image_url: imageUrl,
      caption: caption,
    }, {
        headers: {
        'Authorization': `Bearer ${IG_TOKEN}`
        }
  });
  return res.data.id;
}

async function publishContainer(creationId) {
  const res = await axios.post(`${GRAPH_API}/${IG_USER_ID}/media_publish`, { creation_id: creationId }, {
    headers: {
        'Authorization': `Bearer ${IG_TOKEN}`
        }
  });
  return res.data.id; // published media id
}

async function postToInstagram(imageUrls, caption) {
  let creationId;

  if (imageUrls.length === 1) {
    creationId = await createSingleContainer(imageUrls[0], caption);
  } else {
    const childIds = [];
    for (const url of imageUrls) {
      const childId = await createMediaContainer(url, true);
      childIds.push(childId);
    }
    creationId = await createCarouselContainer(childIds, caption);
  }

  // Graph API sometimes needs a moment before the container is publish-ready
  await new Promise(r => setTimeout(r, 3000));

  return await publishContainer(creationId);
}

async function processQueue() {
  const due = await pool.query(
    `SELECT * FROM post_queue WHERE status = 'pending' AND scheduled_for <= NOW() ORDER BY scheduled_for ASC`
  );

  if (due.rows.length === 0) {
    console.log(`[${new Date().toLocaleTimeString()}] No posts due.`);
    return;
  }

  for (const post of due.rows) {
    console.log(`[${new Date().toLocaleTimeString()}] Publishing post #${post.id} (${post.image_urls.length} image(s))...`);
    try {
      const mediaId = await postToInstagram(post.image_urls, post.caption);

      await pool.query(
        `UPDATE post_queue SET status = 'posted', posted_at = NOW(), ig_media_id = $1 WHERE id = $2`,
        [mediaId, post.id]
      );
      console.log(`  ✅ Posted. IG media id: ${mediaId}`);
    } catch (err) {
      const errMsg = err.response?.data?.error?.message || err.message;
      console.error(`  ❌ Failed post #${post.id}: ${errMsg}`);
      await pool.query(
        `UPDATE post_queue SET status = 'failed', error_message = $1 WHERE id = $2`,
        [errMsg, post.id]
      );
    }
  }
}

// Run every 15 minutes
const INTERVAL_MS = 1 * 60 * 1000;
console.log('📤 Instagram posting worker started. Checking every 15 min.');
processQueue();
setInterval(processQueue, INTERVAL_MS);