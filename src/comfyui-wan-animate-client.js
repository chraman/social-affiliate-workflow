// comfyui-fun-control-client.js
// Shared helper for talking to a self-hosted ComfyUI instance running the
// Wan 2.2 5B "Fun Control" workflow (see wan22-5b-fun-control-workflow.json,
// exported straight from the ComfyUI "Save (API Format)" button).
//
// Unlike the plain image-to-video workflow (comfyui-client.js), this one
// takes TWO inputs:
//   - a reference image (what the subject/scene looks like)
//   - a control video (the motion to drive the generation)
// and produces a new video that renders the reference image following the
// control video's motion.
//
// Used the same way as comfyui-client.js: call start...() to queue a job,
// then poll checkVideoStatusUsingComfyUI() the same way as the other
// video backends (Magic Hour / LTX / plain Wan i2v).
//
// Requires the `form-data` package: npm install form-data

const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const FormData = require('form-data');
const workflowTemplate = require('./wan-i2v-animate-workflow.json');

const COMFYUI_BASE = process.env.COMFYUI_BASE_URL || 'http://127.0.0.1:8188';

// Free ngrok tunnels (the usual way to expose a Colab-hosted ComfyUI)
// serve an HTML "you're about to visit..." interstitial to any request
// that doesn't look like a browser — including axios calls — unless this
// header is present. Without it, /prompt, /history, /upload/image etc.
// all silently return HTML instead of JSON.
const NGROK_HEADERS = { 'ngrok-skip-browser-warning': 'true' };

// Node ids inside wan22-5b-fun-control-workflow.json. If you re-export the
// workflow from ComfyUI after editing the graph, these ids can shift —
// double check them against the new JSON before trusting this in production.
const NODE_IDS = {
  positivePrompt: '6',    // CLIPTextEncode (Positive Prompt)
  negativePrompt: '7',    // CLIPTextEncode (Negative Prompt)
  ksampler: '3',           // KSampler (seed lives here)
  loadImage: '70',         // LoadImage (ref_image into Wan22FunControlToVideo)
  loadVideo: '66',         // LoadVideo (control_video source)
  funControlToVideo: '60', // Wan22FunControlToVideo (width/height/length live here)
  videoCombine: '80'       // VHS_VideoCombine (final output node)
};

// ─── Upload a local/remote file into ComfyUI's /input folder ─────────────
// ComfyUI's /upload/image endpoint isn't actually image-only — it just
// stores whatever bytes you send under /input and hands back the filename
// it used. The VHS LoadVideo node (and LoadImage) both just reference a
// filename in /input, so this same endpoint is reused for the control
// video too.
async function uploadFileToComfyUI(fileUrl, { prefix, defaultExt }) {
  const fileRes = await axios.get(fileUrl, { responseType: 'arraybuffer' });

  const urlExt = path.extname(new URL(fileUrl).pathname);
  const ext = urlExt || defaultExt;
  const filename = `${prefix}_${Date.now()}${ext}`;

  const form = new FormData();
  form.append('image', Buffer.from(fileRes.data), { filename });
  form.append('type', 'input');
  form.append('overwrite', 'true');

  const res = await axios.post(`${COMFYUI_BASE}/upload/image`, form, {
    headers: { ...form.getHeaders(), ...NGROK_HEADERS }
  });
  return res.data.name; // filename ComfyUI actually stored it under
}

// ─── Build the prompt payload and queue it ────────────────────────────────
// imageUrl        - reference image (subject/outfit/scene to render)
// controlVideoUrl - the motion-reference video to drive the animation
// userPrompt      - optional override for the positive text prompt
async function startImageToVideoUsingComfyUI(imageUrl, userPrompt) {

 let controlVideoUrl = "https://res.cloudinary.com/ds8bfxetq/video/upload/v1788850364/affiliate-pipeline/women-floral-printed-regular-pure-cotton-kurta-with-palazzos/r6emmdbzhy97gs1ikhwr_motion_151.mp4"

 // ek step aage ake mudhna
//  "https://res.cloudinary.com/ds8bfxetq/video/upload/v1788850364/affiliate-pipeline/women-floral-printed-regular-pure-cotton-kurta-with-palazzos/r6emmdbzhy97gs1ikhwr_motion_151.mp4"
 // dono side tilt krna
 //"https://res.cloudinary.com/ds8bfxetq/video/upload/v1788851829/affiliate-pipeline/women-floral-printed-regular-pure-cotton-kurta-with-palazzos/r6emmdbzhy97gs1ikhwr_motion_154.mp4"
 // side mein hath rakhna 
 // "https://res.cloudinary.com/ds8bfxetq/video/upload/v1788850840/affiliate-pipeline/women-floral-printed-regular-pure-cotton-kurta-with-palazzos/r6emmdbzhy97gs1ikhwr_motion_152.mp4"
  // side mein shoulder ki taraf mudhna
  // "https://res.cloudinary.com/ds8bfxetq/video/upload/v1788851339/affiliate-pipeline/women-floral-printed-regular-pure-cotton-kurta-with-palazzos/r6emmdbzhy97gs1ikhwr_motion_153.mp4"
  const [uploadedImage, uploadedVideo] = await Promise.all([
    uploadFileToComfyUI(imageUrl, { prefix: 'ref', defaultExt: '.png' }),
    uploadFileToComfyUI(controlVideoUrl, { prefix: 'control', defaultExt: '.mp4' })
  ]);

  const workflow = JSON.parse(JSON.stringify(workflowTemplate)); // deep clone
userPrompt = "RAW video frame, high detail, photorealistic, cinematic natural lighting, soft subsurface scattering on skin/fur, natural textures, shot on 35mm lens, 24fps film grain, subtle ambient shadows."
  if (userPrompt) {
    workflow[NODE_IDS.positivePrompt].inputs.text = userPrompt;
  }
  workflow[NODE_IDS.loadImage].inputs.image = uploadedImage;
  workflow[NODE_IDS.loadVideo].inputs.file = uploadedVideo;

  // Randomize the seed each run — otherwise identical inputs can hit
  // ComfyUI's node cache and just replay a previous result.
  workflow[NODE_IDS.ksampler].inputs.seed = crypto.randomInt(0, 281474976710655);

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
// NOTE: same caveat as the other ComfyUI/Magic Hour status checks —
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

  const file = extractOutputFile(entry, NODE_IDS.videoCombine);
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

// VHS_VideoCombine's output key isn't a fixed name across ComfyUI/VHS
// versions (seen as "gifs", "videos", "images" depending on version) — so
// scan whichever key holds an array of {filename, subfolder, type} objects
// instead of hardcoding one.
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
// Unlike hosted services (Cloudinary can fetch a remote URL directly),
// ComfyUI usually runs on localhost or a private LAN/Colab box that
// Cloudinary's servers can't reach — so we pull the bytes ourselves here
// and let the caller upload the buffer instead.
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