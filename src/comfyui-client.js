// comfyui-client.js
// Shared helper for talking to a self-hosted ComfyUI instance running the
// Wan 2.2 5B image-to-video workflow (see wan22-i2v-workflow.json, exported
// straight from the ComfyUI "Save (API Format)" button).
//
// Used by server.js (to kick a job off) and videoWorker.js (to poll it,
// same pattern as the Magic Hour / LTX jobs).
//
// Requires the `form-data` package: npm install form-data

const axios = require('axios');
const crypto = require('crypto');
const FormData = require('form-data');
const workflowTemplate = require('./wan22-i2v-workflow.json');

const COMFYUI_BASE = process.env.COMFYUI_BASE_URL || 'http://127.0.0.1:8188';

// Free ngrok tunnels (the usual way to expose a Colab-hosted ComfyUI)
// serve an HTML "you're about to visit..." interstitial to any request
// that doesn't look like a browser — including axios calls — unless this
// header is present. Without it, /prompt, /history, /upload/image etc.
// all silently return HTML instead of JSON.
const NGROK_HEADERS = { 'ngrok-skip-browser-warning': 'true' };

// Node ids inside wan22-i2v-workflow.json. If you re-export the workflow
// from ComfyUI after editing the graph, these ids can shift — double check
// them against the new JSON before trusting this in production.
const NODE_IDS = {
  positivePrompt: '6',   // CLIPTextEncode (Positive Prompt)
  seed: '3',             // KSampler
  loadImage: '56',       // LoadImage
  saveVideo: '58'        // SaveVideo
};

// ─── Upload the source image into ComfyUI's /input folder ────────────────
// The workflow JSON references images by filename, not URL, so we download
// the Cloudinary image ourselves and re-upload it into ComfyUI before
// queuing the prompt.
async function uploadImageToComfyUI(imageUrl) {
  const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer' });

  const form = new FormData();
  const filename = `src_${Date.now()}.png`;
  form.append('image', Buffer.from(imgRes.data), { filename });
  form.append('type', 'input');
  form.append('overwrite', 'true');

  const res = await axios.post(`${COMFYUI_BASE}/upload/image`, form, {
    headers: { ...form.getHeaders(), ...NGROK_HEADERS }
  });
  return res.data.name; // filename ComfyUI actually stored it under
}

// ─── Build the prompt payload and queue it ────────────────────────────────
async function startImageToVideoUsingComfyUI(imageUrl, userPrompt) {
  const uploadedFilename = await uploadImageToComfyUI(imageUrl);

  const workflow = JSON.parse(JSON.stringify(workflowTemplate)); // deep clone
  userPrompt = "Photorealistic I2V. The subject remains facing forward at all times, maintaining continuous direct eye contact with the camera. Absolute facial consistency, zero head movement, zero body rotation. She slowly and gracefully raises one hand to gently touch her hair near her ear, then softly lowers it back down. Subtle, natural fabric physics on her sleeveless patterned outfit. Fixed camera angle, stable background, cinematic lighting."
  if (userPrompt) {
    workflow[NODE_IDS.positivePrompt].inputs.text = userPrompt;
  }
  workflow[NODE_IDS.loadImage].inputs.image = uploadedFilename;
  // Randomize the seed each run — otherwise identical inputs can hit
  // ComfyUI's node cache and just replay a previous result.
  workflow[NODE_IDS.seed].inputs.seed = crypto.randomInt(0, 281474976710655);

  const clientId = crypto.randomUUID();
  const res = await axios.post(`${COMFYUI_BASE}/prompt`, {
    prompt: workflow,
    client_id: clientId
  }, {
    headers: NGROK_HEADERS
  });

  if (res.data.node_errors && Object.keys(res.data.node_errors).length > 0) {
    throw new Error(`ComfyUI rejected the workflow: ${JSON.stringify(res.data.node_errors)}`);
  }

  return res.data.prompt_id;
}

// ─── Poll job status ───────────────────────────────────────────────────────
// NOTE: same caveat as the Magic Hour status check in videoWorker.js —
// /history/{id} is the standard ComfyUI endpoint, but the exact shape of a
// queued/running/errored entry can vary a bit across ComfyUI versions.
// Confirm with one manual call (curl {base}/history/{prompt_id}) before
// trusting this in production.
async function checkVideoStatusUsingComfyUI(promptId) {
  const url = `${COMFYUI_BASE}/history/${promptId}`;
  let res;
  try {
    res = await axios.get(url, { headers: NGROK_HEADERS });
  } catch (err) {
    // Surface the URL we hit — makes it obvious when this is actually an
    // ngrok tunnel that rotated out from under a still-processing job,
    // rather than a real ComfyUI-side failure.
    err.message = `${err.message} (URL: ${url})`;
    throw err;
  }
  const entry = res.data[promptId];

  if (!entry) {
    // Not in history yet — still queued or actively running.
    return { status: 'processing' };
  }

  const statusMessages = entry.status?.messages || [];
  const hasError = statusMessages.some(m => m[0] === 'execution_error') ||
    entry.status?.status_str === 'error';
  if (hasError) {
    const errMsg = statusMessages.find(m => m[0] === 'execution_error')?.[1]?.exception_message
      || 'ComfyUI execution failed';
    return { status: 'error', error: errMsg };
  }

  const file = extractOutputFile(entry, NODE_IDS.saveVideo);
  if (!file) {
    // History entry exists but no recognizable video output yet — treat as
    // still processing rather than silently failing.
    return { status: 'processing' };
  }

  // Log exactly what ComfyUI told us about the output file — if the
  // eventual /view download 404s, compare this against what's actually in
  // ComfyUI's output folder (subfolder/type mismatches are the usual cause).
  console.log('  [ComfyUI] output file metadata:', file);

  const videoUrl = `${COMFYUI_BASE}/view?filename=${encodeURIComponent(file.filename)}` +
    `&subfolder=${encodeURIComponent(file.subfolder || '')}&type=${file.type || 'output'}`;
  return { status: 'completed', video_url: videoUrl };
}

// The SaveVideo node's output key name isn't 100% consistent across
// ComfyUI versions (seen as "images", "gifs", "videos" depending on
// version/node set) — so scan whichever key holds an array of
// {filename, subfolder, type} objects instead of hardcoding one.
function extractOutputFile(historyEntry, saveNodeId) {
  const nodeOutput = historyEntry?.outputs?.[saveNodeId];
  if (!nodeOutput) return null;
  for (const key of Object.keys(nodeOutput)) {
    const val = nodeOutput[key];
    if (Array.isArray(val) && val[0]?.filename) return val[0];
  }
  return null;
}

// ─── Download the finished video's bytes ──────────────────────────────────
// Unlike Magic Hour/LTX (hosted services, so Cloudinary can fetch the
// remote URL directly), ComfyUI usually runs on localhost or a private LAN
// box that Cloudinary's servers can't reach — so we pull the bytes
// ourselves here and let the caller upload the buffer instead.
async function downloadComfyUIVideo(videoUrl) {
  try {
    const res = await axios.get(videoUrl, { responseType: 'arraybuffer', headers: NGROK_HEADERS });
    return Buffer.from(res.data);
  } catch (err) {
    err.message = `${err.message} (URL: ${videoUrl})`;
    throw err;
  }
}

module.exports = {
  startImageToVideoUsingComfyUI,
  checkVideoStatusUsingComfyUI,
  downloadComfyUIVideo
};