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
const GRAPH_API = process.env.IG_WORKER_URL;

async function createMediaContainer(imageUrl, isCarouselItem) {
  const res = await axios.post(`${GRAPH_API}/${IG_USER_ID}/media`, {
        image_url: imageUrl,
        is_carousel_item: !!isCarouselItem
    }, {
        headers: {
        'Authorization': `Bearer ${IG_TOKEN}`
        }
    });
  return res.data.id;
}

// Video items inside a carousel need media_type: VIDEO + is_carousel_item: true
async function createVideoChildContainer(videoUrl) {
  const res = await axios.post(`${GRAPH_API}/${IG_USER_ID}/media`, {
    media_type: 'VIDEO',
    video_url: videoUrl,
    is_carousel_item: true
  }, {
    headers: { 'Authorization': `Bearer ${IG_TOKEN}` }
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

// Standalone video post = Reels on IG's current API
async function createReelsContainer(videoUrl, caption) {
  const res = await axios.post(`${GRAPH_API}/${IG_USER_ID}/media`, {
    media_type: 'REELS',
    video_url: videoUrl,
    caption: caption
  }, {
    headers: { 'Authorization': `Bearer ${IG_TOKEN}` }
  });
  return res.data.id;
}

// ─── Stories ──────────────────────────────────────────────────────
// Stories don't support carousels — one media item per container, and no
// caption field is rendered on a story.
async function createImageStoryContainer(imageUrl) {
  const res = await axios.post(`${GRAPH_API}/${IG_USER_ID}/media`, {
    image_url: imageUrl,
    media_type: 'STORIES'
  }, {
    headers: { 'Authorization': `Bearer ${IG_TOKEN}` }
  });
  return res.data.id;
}

async function createVideoStoryContainer(videoUrl) {
  const res = await axios.post(`${GRAPH_API}/${IG_USER_ID}/media`, {
    video_url: videoUrl,
    media_type: 'STORIES'
  }, {
    headers: { 'Authorization': `Bearer ${IG_TOKEN}` }
  });
  return res.data.id;
}

async function postStoryToInstagram(item) {
  let creationId;
  if (item.media_type === 'VIDEO') {
    creationId = await createVideoStoryContainer(item.url);
    await pollContainerReady(creationId);
  } else {
    creationId = await createImageStoryContainer(item.url);
  }

  // Graph API sometimes needs a moment before the container is publish-ready
  await new Promise(r => setTimeout(r, 3000));

  return await publishContainer(creationId);
}

// Video containers (Reels or carousel video children) process asynchronously on
// Meta's side — poll status_code until FINISHED before it can be published/used
// as a carousel child. Image containers don't need this.
async function pollContainerReady(creationId, maxAttempts = 20, intervalMs = 5000) {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await axios.get(`${GRAPH_API}/${creationId}`, {
      params: { fields: 'status_code', access_token: IG_TOKEN }
    });
    const status = res.data.status_code;
    if (status === 'FINISHED') return true;
    if (status === 'ERROR') throw new Error(`Container ${creationId} processing failed (status ERROR)`);
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`Container ${creationId} not ready after ${maxAttempts * intervalMs / 1000}s — try again later`);
}

async function publishContainer(creationId) {
  const res = await axios.post(`${GRAPH_API}/${IG_USER_ID}/media_publish`, { creation_id: creationId }, {
    headers: {
        'Authorization': `Bearer ${IG_TOKEN}`
        }
  });
  return res.data.id; // published media id
}

// items: [{ url, media_type: 'IMAGE' | 'VIDEO' }]
async function postToInstagram(items, caption) {
  let creationId;

  if (items.length === 1) {
    const item = items[0];
    if (item.media_type === 'VIDEO') {
      creationId = await createReelsContainer(item.url, caption);
      await pollContainerReady(creationId);
    } else {
      creationId = await createSingleContainer(item.url, caption);
    }
  } else {
    const childIds = [];
    for (const item of items) {
      if (item.media_type === 'VIDEO') {
        const childId = await createVideoChildContainer(item.url);
        await pollContainerReady(childId);
        childIds.push(childId);
      } else {
        const childId = await createMediaContainer(item.url, true);
        childIds.push(childId);
      }
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
    let items;
    try {
      const itemsRes = await pool.query(
        `SELECT pqi.position, pqi.media_type, pi.image_url AS img_url, pv.video_url
         FROM post_queue_items pqi
         LEFT JOIN product_images pi ON pi.id = pqi.image_id
         LEFT JOIN product_videos pv ON pv.id = pqi.video_id
         WHERE pqi.post_queue_id = $1
         ORDER BY pqi.position ASC`,
        [post.id]
      );
      if (itemsRes.rows.length > 0) {
        items = itemsRes.rows.map(r => ({
          url: r.media_type === 'VIDEO' ? r.video_url : r.img_url,
          media_type: r.media_type || 'IMAGE'
        })).filter(i => !!i.url);
      }
    } catch (e) {
      // pre-migration DB without post_queue_items.media_type / video_id — fall back below
      console.error('Could not read post_queue_items media_type, falling back to image_urls:', e.message);
    }

    if (!items || items.length === 0) {
      items = (post.image_urls || []).map(u => ({ url: u, media_type: 'IMAGE' }));
    }

    const isStory = post.post_type === 'STORY';
    console.log(`[${new Date().toLocaleTimeString()}] Publishing ${isStory ? 'STORY' : 'post'} #${post.id} (${items.length} item(s), ${items.some(i => i.media_type === 'VIDEO') ? 'contains video' : 'images only'})...`);
    try {
      const mediaId = isStory
        ? await postStoryToInstagram(items[0])
        : await postToInstagram(items, post.caption);

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