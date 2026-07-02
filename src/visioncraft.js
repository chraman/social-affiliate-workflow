const axios = require('axios');
const Redis = require('ioredis');
const path = require('path');
require('dotenv').config();

const REDIS_URL = process.env.REDIS_URL;
const VISIONCRAFT_URL = process.env.VISIONCRAFT_URL;
const INFLUENCER_ID = process.env.INFLUENCER_ID;

const vc = axios.create({
  baseURL: VISIONCRAFT_URL,
  headers: { 
    'authorization': 'Bearer ' + process.env.VISIONCRAFT_TOKEN, 
    'Content-Type': 'application/json' },
  timeout: 300000,
});

// ─── Redis pub/sub ────────────────────────────────────────────────────────────
// Separate subscriber client — ioredis requires a dedicated connection for subscribe
let subscriber = null;

function getSubscriber() {
  if (!subscriber) {
    subscriber = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });
    subscriber.on('error', (err) =>
      console.error('❌ Redis subscriber error:', err.message)
    );
  }
  return subscriber;
}

/**
 * Waits for a job to complete via Redis pub/sub on channel `job:status:{jobId}`
 * Resolves with the cdnUrl or imageUrl from the payload.
 * Rejects on FAILED status or timeout.
 */
function waitForJob(jobId, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const channel = `job:status:${jobId}`;
    const sub = getSubscriber();
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      sub.unsubscribe(channel);
      reject(new Error(`Job ${jobId} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    const onMessage = (chan, message) => {
      if (chan !== channel) return;

      let payload;
      try {
        payload = JSON.parse(message);
      } catch {
        return;
      }

      console.log(`📡 Job ${jobId} status: ${payload.status}`);

      if (payload.status === 'COMPLETED') {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sub.unsubscribe(channel);
        sub.removeListener('message', onMessage);
        resolve(payload.cdnUrl || payload.imageUrl || null);
      }

      if (payload.status === 'FAILED') {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sub.unsubscribe(channel);
        sub.removeListener('message', onMessage);
        reject(new Error(`Job failed: ${payload.errorMessage || 'unknown error'}`));
      }
    };

    sub.on('message', onMessage);
    sub.subscribe(channel, (err) => {
      if (err) {
        clearTimeout(timer);
        reject(new Error(`Failed to subscribe to ${channel}: ${err.message}`));
      } else {
        console.log(`📡 Subscribed to ${channel}`);
      }
    });
  });
}

// ─── Step 1: Fetch image URL → base64 ────────────────────────────────────────
async function imageUrlToBase64(imageUrl) {
  const res = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Referer': 'https://www.myntra.com/',
    },
    timeout: 15000,
  });
  return {
    base64: Buffer.from(res.data).toString('base64'),
    contentType: res.headers['content-type'] || 'image/jpeg',
    buffer: Buffer.from(res.data),
  };
}

// ─── Step 2: Describe scene ───────────────────────────────────────────────────
async function describeProductImage(imageUrl) {
  try {
    const { base64 } = await imageUrlToBase64(imageUrl);
    const res = await vc.post('/api/v1/images/describe-scene', {
      imageBase64: base64,
    });
    return (
      res.data?.data?.prompt ||
      res.data?.description ||
      res.data?.caption ||
      null
    );
  } catch (err) {
    console.error('❌ Scene description failed:', err.message);
    return null;
  }
}

// ─── Step 3a: Get presigned upload URL ───────────────────────────────────────
async function getUploadUrl(imageUrl) {
  const filename = path.basename(imageUrl.split('?')[0]) || 'product.jpeg';
  const res = await vc.post('/api/v1/images/upload-url', {
    filename,
    contentType: 'image/jpeg',
  });
  if (!res.data?.success) throw new Error('Failed to get upload URL');
  return res.data.data; // { uploadUrl, key }
}

// ─── Step 3b: Upload image buffer to presigned URL ────────────────────────────
async function uploadImageToStorage(uploadUrl, imageUrl) {
  const { buffer, contentType } = await imageUrlToBase64(imageUrl);
  await axios.put(uploadUrl, buffer, {
    headers: {
      'Content-Type': contentType,
      'Content-Length': buffer.length,
    },
    timeout: 30000,
    maxBodyLength: Infinity,
  });
}

// ─── Step 3c: Trigger influencer generation ───────────────────────────────────
async function triggerInfluencerGeneration(sceneImageKey, targetPrompt) {
  if (!INFLUENCER_ID) throw new Error('INFLUENCER_ID env var not set');

  const res = await vc.post(`/api/v1/influencers/${INFLUENCER_ID}/generate`, {
    targetPrompt,
    aspectRatio: '4:5',
    quality: 'standard',
    referenceStrength: 0.25,
    useInt8: false,
    sceneImageUrl: sceneImageKey,
  });

  if (!res.data?.success) throw new Error('Failed to trigger generation');
  return res.data.data.jobId;
}

// ─── Main: Full influencer image generation flow ──────────────────────────────
async function generateInfluencerImage(productImageUrl) {
  try {
    // Step 1: Describe the product scene first
    console.log('🔍 Describing product scene...');
    const sceneDescription = await describeProductImage(productImageUrl);

    if (!sceneDescription) {
      throw new Error('Could not generate scene description');
    }

    console.log('📝 Scene description:', sceneDescription);

    console.log('📤 Getting upload URL...');
    const { uploadUrl, key } = await getUploadUrl(productImageUrl);

    console.log('⬆️  Uploading product image...');
    await uploadImageToStorage(uploadUrl, productImageUrl);

    // Subscribe BEFORE triggering — avoids race condition where
    // job completes before we subscribe
    console.log('🎨 Triggering influencer generation...');
    const jobId = await triggerInfluencerGeneration(key, sceneDescription);
    console.log(`🆔 Job ID: ${jobId}`);

    console.log('⏳ Waiting for result via Redis pub/sub...');
    const resultUrl = await waitForJob(jobId);

    console.log('✅ Influencer image ready:', resultUrl);
    return resultUrl;
  } catch (err) {
    console.error('❌ Influencer generation failed:', err.message);
    return null;
  }
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────
async function closeVisioncraft() {
  if (subscriber) {
    await subscriber.quit();
    subscriber = null;
  }
}

module.exports = {
  describeProductImage,
  generateInfluencerImage,
  imageUrlToBase64,
  closeVisioncraft,
};