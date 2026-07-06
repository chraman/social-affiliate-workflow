const axios = require('axios');
const Redis = require('ioredis');
const path = require('path');
const { analyzeProductWithGemini, generateImageWithFlux } = require('./generate-product-image')
require('dotenv').config();
const fs = require("fs");

const REDIS_URL = process.env.REDIS_URL;
const VISIONCRAFT_URL = process.env.VISIONCRAFT_URL;
const INFLUENCER_ID = process.env.INFLUENCER_ID;

const TEMPLATE_ARRAY = [
  {
    templateId: 1,
    templateDescription: "home selfie image, white background, black purse and black phone",
    aspectRation:"4:5",
    templateUrl: "http://localhost:9000/dev-ai-images-uploads/uploads/c84d9dce-4aec-4a16-bf66-7a830873ccd6.png",
    templatePrompt: `A stylish woman stands poised in a modern, capturing a mirror selfie with her phone partially obscuring her face. She maintains the same pose, hairstyle, body proportions, camera angle, framing, lighting, background, furniture placement, accessories, footwear and overall composition in every generation.
      Replace ONLY her clothing with the following product. The outfit must exactly match the product specification below, preserving the exact garment count, silhouette, proportions, fabric appearance, colors, prints, embroidery, trims, buttons, seams, closures, pockets, pleats, gathers, ruching, drape, hems, necklines, sleeves, borders, decorative details, and overall construction. Fit the garments naturally to the model while maintaining the original pose.
      PRODUCT SPECIFICATION:`
  },
  {
    templateId: 2,
    templateDescription: "home selfie image, white background, white purse and black phone",
    aspectRation:"9:16",
    templateUrl: "http://localhost:9000/dev-ai-images-generated/generated/cmorf337c000adamw2w6f691b/cmr8vp5ax004nda4o4bou8fhg.png",
    templatePrompt: `A stylish woman stands poised in a modern, capturing a mirror selfie with her phone partially obscuring her face. She maintains the same pose, hairstyle, body proportions, camera angle, framing, lighting, background, furniture placement, accessories, jewerly, footwear and overall composition in every generation.
      Replace ONLY her clothing with the following product. The outfit must exactly match the product specification below, preserving the exact garment count, silhouette, proportions, fabric appearance, colors, prints, embroidery, trims, buttons, seams, closures, pockets, pleats, gathers, ruching, drape, hems, necklines, sleeves, borders, decorative details, and overall construction. Fit the garments naturally to the model while maintaining the original pose.
      PRODUCT SPECIFICATION:`
  }
]

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

async function uploadGeneratedImage(buffer, { filename = `generated-${Date.now()}.png`, contentType = "image/png" } = {}) {
  console.log("→ Requesting presigned upload URL...");
  const { uploadUrl, key } = await getUploadUrl(filename, contentType);
  console.log("→ Uploading generated image to storage...");
  await uploadImageBufferToStorage(uploadUrl, buffer, contentType);
 
  return { uploadUrl : uploadUrl, key: key };
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

// Step 3b: Upload the generated image buffer to the presigned URL
async function uploadImageBufferToStorage(uploadUrl, buffer, contentType = "image/png") {
  await axios.put(uploadUrl, buffer, {
    headers: {
      "Content-Type": contentType,
      "Content-Length": buffer.length,
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
    const productDescription = await analyzeProductWithGemini(productImageUrl);

    if (!productDescription) {
      throw new Error('Could not generate product description');
    }

    console.log('📝 Product description:', productDescription);

    console.log('📤 Getting upload URL...');
    const { uploadUrl, key } = await getUploadUrl(productImageUrl);

    console.log('⬆️  Uploading product image...');
    await uploadImageToStorage(uploadUrl, productImageUrl);

    // Subscribe BEFORE triggering — avoids race condition where
    // job completes before we subscribe
    console.log('🎨 Triggering AI template + Product generation...');
    let templateImageUrl = TEMPLATE_ARRAY[1].templateUrl
    let prompt = TEMPLATE_ARRAY[1].templatePrompt + " " +productDescription
    // Accesseries, jewelry and footware should be based on the prodct category
    const imageBuffer = await generateImageWithFlux({productImageUrl, templateImageUrl, prompt});
    // console.log(`🆔 Job ID: ${jobId}`);

    const outFileName = `generated-${Date.now()}.png`;
 
    console.log("\n→ Step 3: Uploading generated image to storage...");
    let resultData = await uploadGeneratedImage(imageBuffer, {
      filename: outFileName,
      contentType: "image/png",
    });
    let resultUrl = process.env.MINIO_UPLOAD_PATH + resultData.key;
    console.log('✅ Influencer image ready:', resultData.uploadUrl, resultData.key);
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