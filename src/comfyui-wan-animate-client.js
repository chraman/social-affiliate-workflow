// comfyui-wan-animate-client.js
//
// Client for the WAN 2.2 Animate workflow:
//
//   Reference image -> node 64
//   Motion/reference video -> node 13
//   Positive prompt -> node 124
//   Negative prompt -> node 122
//   WAN model -> node 75
//   Animate embeds -> node 88
//   WAN sampler -> node 90
//   Final video -> node 106
//
// Requires:
//   npm install axios form-data

const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const FormData = require('form-data');

const workflowTemplate = require(
  './wan-i2v-animate-workflow.json'
);

const COMFYUI_BASE =
  process.env.COMFYUI_BASE_URL || 'http://127.0.0.1:8188';

const NGROK_HEADERS = {
  'ngrok-skip-browser-warning': 'true'
};


// ============================================================
// WAN ANIMATE NODE IDS
// ============================================================

const NODE_IDS = {
  // Input
  loadVideo: '13',
  loadImage: '64',

  // Prompt
  negativePrompt: '122',
  positivePrompt: '124',

  // WAN sampler
  sampler: '90',

  // Processing
  animateEmbeds: '88',

  // FWS
  divideFws: '161',

  // Final output
  videoCombine: '106'
};


// ============================================================
// UPLOAD FILE TO COMFYUI
// ============================================================

async function uploadFileToComfyUI(
  fileUrl,
  {
    prefix,
    defaultExt
  }
) {
  console.log(`[ComfyUI] Downloading ${fileUrl}`);

  const fileRes = await axios.get(fileUrl, {
    responseType: 'arraybuffer'
  });

  const urlExt = path.extname(
    new URL(fileUrl).pathname
  );

  const ext = urlExt || defaultExt;

  const filename =
    `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;

  const form = new FormData();

  form.append(
    'image',
    Buffer.from(fileRes.data),
    {
      filename
    }
  );

  form.append('type', 'input');
  form.append('overwrite', 'true');

  console.log(
    `[ComfyUI] Uploading ${filename}`
  );

  const res = await axios.post(
    `${COMFYUI_BASE}/upload/image`,
    form,
    {
      headers: {
        ...form.getHeaders(),
        ...NGROK_HEADERS
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    }
  );

  console.log(
    `[ComfyUI] Uploaded as ${res.data.name}`
  );

  return res.data.name;
}


// ============================================================
// START WAN ANIMATE JOB
// ============================================================
//
// imageUrl:
//   Reference/person/image to animate
//
// controlVideoUrl:
//   Motion/reference video
//
// userPrompt:
//   Positive prompt
//
// options:
//   Optional workflow overrides
//
// ============================================================

async function startImageToVideoUsingComfyUI(
  imageUrl,
  controlVideoUrl,
  userPrompt,
  options = {}
) {
  if (!imageUrl) {
    throw new Error('imageUrl is required');
  }
  controlVideoUrl = "https://res.cloudinary.com/ds8bfxetq/video/upload/v1788862999/affiliate-pipeline/solid-top-with-shorts/g4niodlridhm15aawuk0_motion_162.mp4"
  if (!controlVideoUrl) {
    throw new Error('controlVideoUrl is required');
  }

  console.log(
    '[ComfyUI] Starting WAN 2.2 Animate job'
  );

  // ----------------------------------------------------------
  // Upload both inputs
  // ----------------------------------------------------------

  const [
    uploadedImage,
    uploadedVideo
  ] = await Promise.all([
    uploadFileToComfyUI(
      imageUrl,
      {
        prefix: 'wan_animate_ref',
        defaultExt: '.png'
      }
    ),

    uploadFileToComfyUI(
      controlVideoUrl,
      {
        prefix: 'wan_animate_motion',
        defaultExt: '.mp4'
      }
    )
  ]);

  // ----------------------------------------------------------
  // Deep clone workflow
  // ----------------------------------------------------------

  const workflow =
    JSON.parse(
      JSON.stringify(workflowTemplate)
    );

  // ----------------------------------------------------------
  // INPUT VIDEO
  //
  // WAN Animate workflow node 13:
  //
  // "video": "filename.mp4"
  //
  // ----------------------------------------------------------

  workflow[NODE_IDS.loadVideo]
    .inputs
    .video = uploadedVideo;


  // ----------------------------------------------------------
  // REFERENCE IMAGE
  //
  // WAN Animate workflow node 64:
  //
  // "image": "filename.png"
  //
  // ----------------------------------------------------------

  workflow[NODE_IDS.loadImage]
    .inputs
    .image = uploadedImage;


  // ----------------------------------------------------------
  // POSITIVE PROMPT
  // ----------------------------------------------------------

  if (userPrompt) {
    workflow[NODE_IDS.positivePrompt]
      .inputs
      .text = userPrompt;
  }


  // ----------------------------------------------------------
  // OPTIONAL NEGATIVE PROMPT
  // ----------------------------------------------------------

  if (options.negativePrompt) {
    workflow[NODE_IDS.negativePrompt]
      .inputs
      .text = options.negativePrompt;
  }


  // ----------------------------------------------------------
  // RANDOM SEED
  //
  // WAN Animate uses node 90, NOT a KSampler node.
  // ----------------------------------------------------------

  workflow[NODE_IDS.sampler]
    .inputs
    .seed =
      options.seed !== undefined
        ? options.seed
        : crypto.randomInt(
            0,
            281474976710655
          );


  // ----------------------------------------------------------
  // OPTIONAL SAMPLER SETTINGS
  // ----------------------------------------------------------

  if (options.steps !== undefined) {
    workflow[NODE_IDS.sampler]
      .inputs
      .steps = options.steps;
  }

  if (options.cfg !== undefined) {
    workflow[NODE_IDS.sampler]
      .inputs
      .cfg = options.cfg;
  }

  if (options.shift !== undefined) {
    workflow[NODE_IDS.sampler]
      .inputs
      .shift = options.shift;
  }

  if (options.denoiseStrength !== undefined) {
    workflow[NODE_IDS.sampler]
      .inputs
      .denoise_strength =
        options.denoiseStrength;
  }


  // ----------------------------------------------------------
  // FWS
  //
  // Node 161 controls Divide FWS.
  //
  // Recommended for L4:
  //   2 = ~33 frame windows for 65 frames
  //   4 = ~17 frame windows
  //
  // Default to 2 for cleaner temporal motion.
  // ----------------------------------------------------------

  if (options.divideFws !== undefined) {
    workflow[NODE_IDS.divideFws]
      .inputs
      .value = options.divideFws;
  }


  // ----------------------------------------------------------
  // WAN ANIMATE OFFLOAD SETTINGS
  // ----------------------------------------------------------

  if (options.forceOffload !== undefined) {
    workflow[NODE_IDS.animateEmbeds]
      .inputs
      .force_offload =
        options.forceOffload;
  }

  if (options.tiledVae !== undefined) {
    workflow[NODE_IDS.animateEmbeds]
      .inputs
      .tiled_vae =
        options.tiledVae;
  }


  // ----------------------------------------------------------
  // LOG IMPORTANT SETTINGS
  // ----------------------------------------------------------

  console.log(
    '[ComfyUI] WAN Animate settings:',
    {
      video: uploadedVideo,
      image: uploadedImage,
      seed:
        workflow[NODE_IDS.sampler]
          .inputs.seed,

      steps:
        workflow[NODE_IDS.sampler]
          .inputs.steps,

      cfg:
        workflow[NODE_IDS.sampler]
          .inputs.cfg,

      divideFws:
        workflow[NODE_IDS.divideFws]
          .inputs.value,

      forceOffload:
        workflow[NODE_IDS.animateEmbeds]
          .inputs.force_offload,

      tiledVae:
        workflow[NODE_IDS.animateEmbeds]
          .inputs.tiled_vae
    }
  );


  // ----------------------------------------------------------
  // QUEUE WORKFLOW
  // ----------------------------------------------------------

  const clientId =
    crypto.randomUUID();

  let res;

  try {
    res = await axios.post(
      `${COMFYUI_BASE}/prompt`,
      {
        prompt: workflow,
        client_id: clientId
      },
      {
        headers: {
          ...NGROK_HEADERS,
          'Content-Type': 'application/json'
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      }
    );

  } catch (err) {
    const responseData =
      err.response?.data;

    console.error(
      '[ComfyUI] Queue error:',
      responseData || err.message
    );

    throw new Error(
      `ComfyUI queue failed: ${
        typeof responseData === 'string'
          ? responseData
          : JSON.stringify(responseData)
      }`
    );
  }


  // ----------------------------------------------------------
  // COMFYUI WORKFLOW VALIDATION ERRORS
  // ----------------------------------------------------------

  if (
    res.data.node_errors &&
    Object.keys(res.data.node_errors).length > 0
  ) {
    throw new Error(
      `ComfyUI rejected the workflow: ${
        JSON.stringify(
          res.data.node_errors,
          null,
          2
        )
      }`
    );
  }


  if (!res.data.prompt_id) {
    throw new Error(
      `ComfyUI did not return prompt_id: ${
        JSON.stringify(res.data)
      }`
    );
  }


  console.log(
    `[ComfyUI] Job queued: ${res.data.prompt_id}`
  );


  return res.data.prompt_id;
}


// ============================================================
// CHECK VIDEO STATUS
// ============================================================
function findVideoOutput(outputs) {
  if (!outputs) {
    return null;
  }

  // Video extensions we accept
  const videoExtensions = [
    '.mp4',
    '.webm',
    '.mov',
    '.mkv',
    '.avi'
  ];

  // ----------------------------------------------------------
  // Search every node
  // ----------------------------------------------------------

  for (const nodeId of Object.keys(outputs)) {

    const nodeOutput = outputs[nodeId];

    if (!nodeOutput) {
      continue;
    }

    // --------------------------------------------------------
    // VHS_VideoCombine normally exposes `gifs`
    // --------------------------------------------------------

    if (Array.isArray(nodeOutput.gifs)) {

      for (const file of nodeOutput.gifs) {

        if (
          file &&
          file.filename &&
          isVideoFile(file.filename)
        ) {
          console.log(
            `[ComfyUI] Found video in node ${nodeId}:`,
            file.filename
          );

          return file;
        }
      }
    }

    // --------------------------------------------------------
    // Some versions expose `videos`
    // --------------------------------------------------------

    if (Array.isArray(nodeOutput.videos)) {

      for (const file of nodeOutput.videos) {

        if (
          file &&
          file.filename &&
          isVideoFile(file.filename)
        ) {
          console.log(
            `[ComfyUI] Found video in node ${nodeId}:`,
            file.filename
          );

          return file;
        }
      }
    }

    // --------------------------------------------------------
    // Generic recursive search
    // --------------------------------------------------------

    const found =
      findVideoFileRecursive(
        nodeOutput
      );

    if (found) {
      console.log(
        `[ComfyUI] Found video in node ${nodeId}:`,
        found.filename
      );

      return found;
    }
  }

  return null;
}
function findVideoOutput(outputs) {
  if (!outputs) {
    return null;
  }

  // Video extensions we accept
  const videoExtensions = [
    '.mp4',
    '.webm',
    '.mov',
    '.mkv',
    '.avi'
  ];

  // ----------------------------------------------------------
  // Search every node
  // ----------------------------------------------------------

  for (const nodeId of Object.keys(outputs)) {

    const nodeOutput = outputs[nodeId];

    if (!nodeOutput) {
      continue;
    }

    // --------------------------------------------------------
    // VHS_VideoCombine normally exposes `gifs`
    // --------------------------------------------------------

    if (Array.isArray(nodeOutput.gifs)) {

      for (const file of nodeOutput.gifs) {

        if (
          file &&
          file.filename &&
          isVideoFile(file.filename)
        ) {
          console.log(
            `[ComfyUI] Found video in node ${nodeId}:`,
            file.filename
          );

          return file;
        }
      }
    }

    // --------------------------------------------------------
    // Some versions expose `videos`
    // --------------------------------------------------------

    if (Array.isArray(nodeOutput.videos)) {

      for (const file of nodeOutput.videos) {

        if (
          file &&
          file.filename &&
          isVideoFile(file.filename)
        ) {
          console.log(
            `[ComfyUI] Found video in node ${nodeId}:`,
            file.filename
          );

          return file;
        }
      }
    }

    // --------------------------------------------------------
    // Generic recursive search
    // --------------------------------------------------------

    const found =
      findVideoFileRecursive(
        nodeOutput
      );

    if (found) {
      console.log(
        `[ComfyUI] Found video in node ${nodeId}:`,
        found.filename
      );

      return found;
    }
  }

  return null;
}
async function checkVideoStatusUsingComfyUI(promptId) {
  try {
    const res = await axios.get(
      `${COMFYUI_BASE}/history/${promptId}`,
      {
        headers: NGROK_HEADERS,
        timeout: 30000
      }
    );

    const history = res.data;

    // ComfyUI has not written history yet
    if (!history || Object.keys(history).length === 0) {
      return {
        status: 'processing',
        prompt_id: promptId
      };
    }

    const entry = history[promptId];

    if (!entry) {
      return {
        status: 'processing',
        prompt_id: promptId
      };
    }

    // --------------------------------------------------------
    // Check ComfyUI execution status
    // --------------------------------------------------------

    const status = entry.status || {};
    const statusString = status.status_str;

    console.log(
      '[ComfyUI] status:',
      statusString
    );

    if (statusString === 'error') {
      return {
        status: 'error',
        prompt_id: promptId,
        error: JSON.stringify(
          status.messages || [],
          null,
          2
        )
      };
    }

    // --------------------------------------------------------
    // Search ALL output nodes for a video file
    // Don't depend only on node 106.
    // --------------------------------------------------------

    const videoFile = findVideoOutput(
      entry.outputs
    );

    if (videoFile) {
      const videoUrl =
        `${COMFYUI_BASE}/view` +
        `?filename=${encodeURIComponent(
          videoFile.filename
        )}` +
        `&subfolder=${encodeURIComponent(
          videoFile.subfolder || ''
        )}` +
        `&type=${encodeURIComponent(
          videoFile.type || 'output'
        )}`;

      console.log(
        '[ComfyUI] VIDEO READY:',
        videoUrl
      );

      return {
        status: 'completed',
        prompt_id: promptId,
        video_url: videoUrl,
        filename: videoFile.filename,
        subfolder: videoFile.subfolder || '',
        type: videoFile.type || 'output'
      };
    }

    // --------------------------------------------------------
    // History exists but output isn't available yet
    // --------------------------------------------------------

    return {
      status: 'processing',
      prompt_id: promptId
    };

  } catch (err) {

    console.error(
      '[ComfyUI] Status check failed:',
      err.response?.data || err.message
    );

    throw err;
  }
}


// ============================================================
// EXTRACT VIDEO FROM VHS_VIDEO_COMBINE
// ============================================================

function extractOutputFile(
  historyEntry,
  saveNodeId
) {
  const nodeOutput =
    historyEntry?.outputs?.[saveNodeId];

  if (!nodeOutput) {
    return null;
  }


  for (
    const key of Object.keys(nodeOutput)
  ) {

    const value =
      nodeOutput[key];

    if (
      Array.isArray(value) &&
      value.length > 0 &&
      value[0]?.filename
    ) {
      return value[0];
    }
  }


  return null;
}


// ============================================================
// DOWNLOAD FINAL VIDEO
// ============================================================

async function downloadComfyUIVideo(
  videoUrl
) {
  try {

    const res =
      await axios.get(
        videoUrl,
        {
          responseType: 'arraybuffer',
          headers: NGROK_HEADERS,
          maxContentLength: Infinity,
          maxBodyLength: Infinity
        }
      );


    return Buffer.from(
      res.data
    );

  } catch (err) {

    err.message =
      `${err.message} (URL: ${videoUrl})`;

    throw err;
  }
}


// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  startImageToVideoUsingComfyUI,
  checkVideoStatusUsingComfyUI,
  downloadComfyUIVideo
};