/**
 * generate-product-image.js
 *
 * Pipeline:
 *   1. Take a product image -> send to Gemini 2.5 Flash (multimodal) with a
 *      system prompt that extracts a clean product description.
 *   2. Take that description + template image URL + template prompt +
 *      original product image -> POST to your Kaggle Flux server (exposed
 *      via ngrok) to generate the final composited/styled image.
 *   3. Save the returned image locally.
 *
 * Usage:
 *   node generate-product-image.js ./product.jpg
 *
 * Env vars (put these in a .env file, loaded via dotenv):
 *   GEMINI_API_KEY=xxxx
 *   NGROK_FLUX_URL=https://xxxx-xx-xx-xx-xx.ngrok-free.app/generate
 *   TEMPLATE_IMAGE_URL=https://.../template.jpg
 *   TEMPLATE_PROMPT="your fixed template prompt text here"
 *
 * Install deps:
 *   npm install axios dotenv form-data mime-types
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const FormData = require("form-data");
const mime = require("mime-types");

// ---------------------------------------------------------------------------
// Config — pulled from env, with a couple of sane fallbacks
// ---------------------------------------------------------------------------
const CONFIG = {
  geminiApiKey: process.env.GEMINI_API_KEY,
  geminiModel: "gemini-3.1-flash-lite",
  geminiEndpoint: (model) =>
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,

  ngrokFluxUrl: process.env.NGROK_FLUX_URL,
  strength: process.env.FLUX_STRENGTH ? Number(process.env.FLUX_STRENGTH) : 0.75,

  outputDir: path.join(__dirname, "output"),
};

// System prompt that tells Gemini exactly what to extract. Keep this tight —
// the output feeds directly into the Flux prompt, so we want a dense,
// visually-descriptive paragraph, not chatty commentary.
const GEMINI_SYSTEM_PROMPT_FOR_PRODUCT_DESCRIPTION = `
You are a world-class fashion technical designer, apparel engineer, and AI fashion reverse-engineering expert.

Your task is NOT to describe the image.

Your task is to extract ONLY the clothing product being sold and generate a concise reconstruction specification that another AI image generation model can use to faithfully recreate the product.

Ignore completely:
- Person
- Face
- Hair
- Skin
- Body
- Pose
- Expression
- Background
- Lighting
- Camera
- Environment

Focus ONLY on the product.

First determine:
- Product type
- Number of garments included
- Included garments
- Visible styling items that are NOT included

Then generate ONE continuous reconstruction description.

The description should ONLY contain information that materially affects visual reconstruction.

Include:
- Product type and garment count
- Garment silhouette
- Fit
- Length
- Neckline / collar
- Sleeves
- Shoulder construction
- Waist construction
- Cut-outs
- Closures
- Button count and placement
- Pocket placement (if visible)
- Hem shape
- Side slits (if any)
- Pleats, gathers, ruching or draping
- Fabric appearance
- Fabric texture
- Fabric weight (only if visually apparent)
- Surface finish (matte, sheen, etc.)
- Colors
- Print and motif
- Embroidery
- Lace
- Borders
- Piping
- Decorative trims
- Visible seam placement
- Any distinctive construction details

Describe ONLY what is visually supported.

If part of the garment is hidden, continue the visible design naturally without inventing new fashion details.

Do NOT describe manufacturing details that cannot be observed.

Do NOT describe the model.

Do NOT use marketing language.

Do NOT repeat information.

Do NOT explain your reasoning.

Do NOT use bullet points.

Do NOT use headings.

Return exactly ONE continuous paragraph between 150 and 300 words, total chars not more that 1200. optimized for direct use inside an AI image generation prompt.
`.trim();

const GEMINI_SYSTEM_PROMPT_FOR_ACCESSORIES = `
You are an expert fashion stylist and AI prompt engineer specializing in FLUX text-to-image prompting. 

I am going to provide you with a product description of a clothing item. Your task is to analyze the clothing's style, fabric, and color, and then generate ONE single, cohesive FLUX image prompt that displays the outfit styled completely with complementary accessories, jewelry, and footwear.

Return exactly ONE continuous paragraph total chars not more that 300. optimized for direct use inside an AI image generation prompt.

Here is the clothing product description:

`.trim();
// ---------------------------------------------------------------------------
// Step 1: Analyze the product image with Gemini 2.5 Flash
// ---------------------------------------------------------------------------
async function analyzeProductWithGemini(productImagePath) {
  if (!CONFIG.geminiApiKey) {
    throw new Error("Missing GEMINI_API_KEY in environment.");
  }

  const imageBuffer = await downloadImageAsBuffer(productImagePath);
  const mimeType = mime.lookup(productImagePath) || "image/jpeg";
  const base64Image = imageBuffer.toString("base64");

  const body = {
    system_instruction: {
      parts: [{ text: GEMINI_SYSTEM_PROMPT_FOR_PRODUCT_DESCRIPTION }],
    },
    contents: [
      {
        role: "user",
        parts: [
          { inline_data: { mime_type: mimeType, data: base64Image } },
          { text: "Analyze this product image and return the description." },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.4
    },
  };

  const url = `${CONFIG.geminiEndpoint(CONFIG.geminiModel)}?key=${CONFIG.geminiApiKey}`;

  const { data } = await axios.post(url, body, {
    headers: { "Content-Type": "application/json" },
    timeout: 60000,
  });

  const description =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("").trim();

  if (!description) {
    throw new Error(
      "Gemini returned no description. Full response: " + JSON.stringify(data)
    );
  }

  return description;
}

async function generateAccessoriesDecription(productDescription) {
  if (!CONFIG.geminiApiKey) {
    throw new Error("Missing GEMINI_API_KEY in environment.");
  }
  let prompt = GEMINI_SYSTEM_PROMPT_FOR_ACCESSORIES + productDescription
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.4
    },
  };

  const url = `${CONFIG.geminiEndpoint(CONFIG.geminiModel)}?key=${CONFIG.geminiApiKey}`;

  const { data } = await axios.post(url, body, {
    headers: { "Content-Type": "application/json" },
    timeout: 60000,
  });

  const description =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("").trim();

  if (!description) {
    throw new Error(
      "Gemini returned no description. Full response: " + JSON.stringify(data)
    );
  }

  return description;
}
// ---------------------------------------------------------------------------
// Step 2: Send everything to the Kaggle Flux server (via ngrok)
//
// Matches this API shape (confirmed via curl):
//   POST /generate/image
//   Content-Type: multipart/form-data
//   Accept: application/json
//   fields: image, image2, image3, image4 (files), prompt (string),
//           strength (float)
//
// Mapping used here:
//   image  -> template image (downloaded from TEMPLATE_IMAGE_URL)
//   image2 -> product image (the file passed in on the CLI)
//   image3 / image4 -> left empty (reserved for extra reference images)
//   prompt -> template prompt + Gemini's product description, merged
//   strength -> CONFIG.strength (default 0.75, override via FLUX_STRENGTH)
// ---------------------------------------------------------------------------
async function generateImageWithFlux({
  productImageUrl,
  templateImageUrl,
  prompt,
  strength = CONFIG.strength,
}) {
  if (!CONFIG.ngrokFluxUrl) {
    throw new Error("Missing NGROK_FLUX_URL in environment.");
  }

  console.log("→ Downloading template image:", templateImageUrl);
  const templateBuffer = await downloadImageAsBuffer(templateImageUrl);
  const templateExt = path.extname(new URL(templateImageUrl).pathname) || ".png";
  console.log("→ Downloading product image:", productImageUrl);
  const productBuffer = await downloadImageAsBuffer(productImageUrl);
  const productExt = path.extname(new URL(productImageUrl).pathname) || ".png";


  const form = new FormData();
  form.append("image", templateBuffer, {
    filename: `template${templateExt}`,
    contentType: mime.lookup(templateExt) || "image/png",
  });
  form.append("image2", productBuffer, {
    filename: `product${productExt}`,
    contentType: mime.lookup(productExt) || "image/png",
  });
  // image3 / image4 intentionally left blank — add more reference images here
  // later if the pipeline needs them (e.g. a second angle of the product).
  form.append("prompt", prompt);
  form.append("strength", String(strength));

  console.log("→ Sending request to Flux server:", CONFIG.ngrokFluxUrl);
  console.log("→ Prompt:\n", prompt, "\n");

  const response = await axios.post(CONFIG.ngrokFluxUrl, form, {
    headers: {
      ...form.getHeaders(),
      Accept: "application/json",
      "ngrok-skip-browser-warning": "true", // avoids ngrok's interstitial HTML page
    },
    responseType: "arraybuffer", // read raw bytes first; we decide how to parse below
    timeout: 5 * 60 * 1000, // Flux generation can be slow — 5 min timeout
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  return extractImageBuffer(response);
}

// The server responds with `application/json`, but the exact shape of that
// JSON (which key holds the image) can vary by implementation. This helper
// tries the common patterns: a base64 string under a few likely key names,
// a data URL, or a hosted URL to fetch. Adjust the key names once you see
// your server's actual response shape.
async function extractImageBuffer(response) {
  const contentType = response.headers["content-type"] || "";

  // Case 1: server actually sent raw image bytes despite Accept: json
  if (contentType.startsWith("image/")) {
    return Buffer.from(response.data);
  }

  // Case 2: JSON response
  let json;
  try {
    json = JSON.parse(Buffer.from(response.data).toString("utf-8"));
  } catch (e) {
    throw new Error(
      "Expected JSON from Flux server but couldn't parse response: " + e.message
    );
  }

  const base64Candidate =
    json.image ||
    json.image_base64 ||
    json.output ||
    json.result ||
    json.data;

  if (typeof base64Candidate === "string") {
    if (base64Candidate.startsWith("http")) {
      return downloadImageAsBuffer(base64Candidate);
    }
    const base64Data = base64Candidate.includes(",")
      ? base64Candidate.split(",")[1] // strip data:image/png;base64, prefix
      : base64Candidate;
    return Buffer.from(base64Data, "base64");
  }

  throw new Error(
    "Could not find image data in Flux response. Full response: " +
      JSON.stringify(json).slice(0, 500)
  );
}

// Helper to download the template image (or a returned image URL) as a buffer.
async function downloadImageAsBuffer(url) {
  const response = await axios.get(url, { responseType: "arraybuffer" });
  return Buffer.from(response.data);
}

module.exports = {
  analyzeProductWithGemini,
  generateImageWithFlux,
  downloadImageAsBuffer,
  generateAccessoriesDecription
};