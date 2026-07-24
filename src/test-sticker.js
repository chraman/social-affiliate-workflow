// test-sticker.js
//
// Approach change: Cloudinary's l_text overlays don't support real stroke/outline,
// and stacking multiple offset text layers (previous version) breaks because each
// overflowing text layer auto-expands the canvas, cascading position downward.
// Fix: render the sticker (pill + stroked + filled text) as one flat PNG locally
// with node canvas (real strokeText, so the outline is an actual outline), then
// overlay that single PNG onto the base image via Cloudinary.
//
// npm install @napi-rs/canvas cloudinary dotenv

const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");
const { v2: cloudinary } = require("cloudinary");
require("dotenv").config();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Replace with your Cloudinary public_id (the photo you're stickering)
const publicId = "affiliate-pipeline/striped-puff-sleeve-shirt-style-top-with-scarf-detail/cwpdnumhunafi9hka3sl";

const sticker = "Check out these cute outfits";

// --- Register a real bold/rounded font -------------------------------------
// napi-rs/canvas uses the fonts you register, not random system fonts.
// Poppins is too "clean geometric" — the reference font has bouncy, rounded
// terminals. Baloo 2 ExtraBold is a much closer match. Download it here:
//   https://fonts.google.com/specimen/Baloo+2  (grab the ExtraBold weight)
// Save it at assets/fonts/Baloo2-ExtraBold.ttf
const path = require("path");
const fs = require("fs");

const FONT_PATH = "./assets/fonts/Baloo2-ExtraBold.ttf";
const FONT_FAMILY = "StickerFont";

const absoluteFontPath = path.resolve(FONT_PATH);
console.log("Looking for font at:", absoluteFontPath);
console.log("File exists on disk:", fs.existsSync(absoluteFontPath));

try {
  const registered = GlobalFonts.registerFromPath(absoluteFontPath, FONT_FAMILY);
  console.log("registerFromPath() returned:", registered);
  console.log("Has our font after registering:", GlobalFonts.has(FONT_FAMILY));
} catch (e) {
  console.warn(`⚠️  Could not load ${absoluteFontPath} — falling back to system sans-serif. Add the font file for an exact match.`);
  console.warn(e.message);
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function renderStickerPNG(text) {
  const fontSize = 58;
  const padX = 34;
  const padY = 15;           // much tighter — target pill is a flat banner, not an oval
  const strokeWidth = 5;    // outline thickness
  const shadowDX = 9;       // MUST be > strokeWidth or the rear copy hides completely behind the outline
  const shadowDY = 9;
  const pillShadowBlur = 10;
  const pillShadowDY = 6;

  const font = `${fontSize}px "${FONT_FAMILY}", sans-serif`;

  // Measure first on a scratch canvas to size the real one exactly
  const scratch = createCanvas(10, 10).getContext("2d");
  scratch.font = font;
  const textWidth = scratch.measureText(text).width;

  const pillWidth = Math.ceil(textWidth + padX * 2);
  const pillHeight = Math.ceil(fontSize * 1.0 + padY * 2);

  // Extra canvas room on the right/bottom for the pill's drop shadow and the
  // offset text copy so nothing gets clipped
  const width = pillWidth + shadowDX + 4;
  const height = pillHeight + shadowDY + pillShadowDY + 4;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // 1. Yellow pill with a soft drop shadow — makes it read as a sticker
  //    sitting on top of the photo rather than a flat rectangle
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.35)";
  ctx.shadowBlur = pillShadowBlur;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = pillShadowDY;
  ctx.fillStyle = "#ffb02e";
  roundRectPath(ctx, 0, 0, pillWidth, pillHeight, pillHeight / 2);
  ctx.fill();
  ctx.restore();

  const cx = pillWidth / 2;
  const cy = pillHeight / 2 + 2;

  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;

  // 2. Rear "jumping" copy — solid dark gray, offset down-right, no outline.
  //    This is what creates the stacked/3D-pop look, not a blurred shadow.
  ctx.fillStyle = "#2b2b2b";
  ctx.fillText(text, cx + shadowDX, cy + shadowDY);

  // 3. Main text on top: black outline (stroke) + white fill, no offset
  ctx.lineWidth = strokeWidth;
  ctx.strokeStyle = "#111111";
  ctx.strokeText(text, cx, cy);

  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, cx, cy);

  return canvas.toBuffer("image/png");
}

async function uploadBuffer(buffer, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (err, result) =>
      err ? reject(err) : resolve(result)
    );
    stream.end(buffer);
  });
}

async function testSticker() {
  try {
    const runId = Date.now(); // guarantees a fresh public_id every run — no stale cache possible

    // Render sticker locally, then push it to Cloudinary as its own asset
    const pngBuffer = renderStickerPNG(sticker);
    const stickerUpload = await uploadBuffer(pngBuffer, {
      folder: "sticker-tests/assets",
      public_id: `sticker-${runId}`,
      overwrite: true,
      invalidate: true,
      resource_type: "image",
    });

    // Composite the sticker PNG onto the base photo — plain image overlay,
    // no font/offset guessing involved, position/rotation "just work".
    const transformedUrl = cloudinary.url(publicId, {
      secure: true,
      transformation: [
        { width: 1080, crop: "scale" },
        {
          overlay: stickerUpload.public_id.replace(/\//g, ":"),
          gravity: "north",
          y: 200,
          flags: "layer_apply",
        },
      ],
    });

    console.log("Transformation URL:");
    console.log(transformedUrl);

    const result = await cloudinary.uploader.upload(transformedUrl, {
      resource_type: "image",
      folder: "sticker-tests",
      public_id: `todays-look-test-${runId}`,
      overwrite: true,
      invalidate: true,
    });

    console.log("\n✅ Uploaded Successfully");
    console.log(result.secure_url);
  } catch (err) {
    console.error(err);
  }
}

testSticker();