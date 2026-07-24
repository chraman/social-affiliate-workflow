// animated-sticker.js
//
// Pill is static and visible from frame 0 (sized to fit the FULL final
// sentence so it never resizes). Each word then pops in individually with
// its own bounce (small -> overshoot -> settle), staggered in time, and
// stays put once landed — building up the sentence word by word, matching
// the reference video. Once all words have landed, the frame holds static
// for the remainder of the clip.
//
// npm install @napi-rs/canvas cloudinary ffmpeg-static

const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { v2: cloudinary } = require("cloudinary");

const FONT_PATH = path.resolve("./assets/fonts/Baloo2-ExtraBold.ttf");
const FONT_FAMILY = "StickerFont";
if (fs.existsSync(FONT_PATH)) {
  GlobalFonts.registerFromPath(FONT_PATH, FONT_FAMILY);
} else {
  console.warn(`⚠️  Font not found at ${FONT_PATH} — using fallback sans-serif.`);
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

// Draws one word, centered at (centerX, centerY), scaled around its own
// center — same visual recipe as before (rear "jump" copy + black outline +
// white fill), just scoped to a single word instead of the whole sentence.
function drawWord(ctx, word, centerX, centerY, scale, opts) {
  if (scale <= 0.001) return; // not started yet — nothing to draw

  const { font, strokeWidth, shadowDX, shadowDY } = opts;

  ctx.save();
  ctx.translate(centerX, centerY);
  ctx.scale(scale, scale);

  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;

  // Rear "jump" copy
  ctx.fillStyle = "#2b2b2b";
  ctx.fillText(word, shadowDX, shadowDY);

  // Main outlined text
  ctx.lineWidth = strokeWidth;
  ctx.strokeStyle = "#111111";
  ctx.strokeText(word, 0, 0);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(word, 0, 0);

  ctx.restore();
}

// Bounce curve for a single word's entrance, relative to ITS OWN start time.
// Returns 0 before it starts, ramps 0->OVERSHOOT->1, then holds at 1.
function makeScaleFn({ popDuration, settleDuration, startScale, overshoot }) {
  return function scaleAt(localT) {
    if (localT < 0) return 0;
    if (localT < popDuration) return startScale + (1 - startScale) * (localT / popDuration);
    if (localT < popDuration + settleDuration) {
      return overshoot + (1 - overshoot) * ((localT - popDuration) / settleDuration);
    }
    return 1;
  };
}

/**
 * Renders the word-by-word bounce-in sticker animation and uploads it to
 * Cloudinary. Returns the Cloudinary public_id of the uploaded WebM.
 *
 * @param {string} text - sticker text (split on spaces into words)
 * @param {object} options
 * @param {number} options.fps
 * @param {number} options.totalDurationSec - total clip length (match the
 *   hold duration of the first image)
 * @param {number} options.wordStagger - seconds between each word's start
 * @param {string} options.folder
 * @param {string} options.publicId - unique per run!
 */
async function generateAnimatedSticker(text, options = {}) {
  const {
    fps = 30,
    totalDurationSec = 3,
    wordStagger = 0.12,
    folder = "sticker-tests/animated",
    publicId = `sticker-anim-${Date.now()}`,
  } = options;

  const fontSize = 58;
  const padX = 34;
  const padY = 8;
  const strokeWidth = 5;
  const shadowDX = 9;
  const shadowDY = 9;

  const font = `${fontSize}px "${FONT_FAMILY}", sans-serif`;

  const scratch = createCanvas(10, 10).getContext("2d");
  scratch.font = font;

  // Pill is sized to the FULL final sentence — it never changes size.
  const fullTextWidth = scratch.measureText(text).width;
  const pillWidth = Math.ceil(fullTextWidth + padX * 2);
  const pillHeight = Math.ceil(fontSize * 1.0 + padY * 2);

  const canvasWidth = Math.ceil(pillWidth * 1.15); // a little slack for word overshoot
  const canvasHeight = Math.ceil(pillHeight * 1.3);

  // --- Precompute each word's center position within the pill ------------
  const words = text.trim().split(/\s+/);
  const spaceWidth = scratch.measureText(" ").width;
  const wordWidths = words.map((w) => scratch.measureText(w).width);
  const totalWordsWidth = wordWidths.reduce((a, b) => a + b, 0) + spaceWidth * (words.length - 1);

  const pillCenterX = canvasWidth / 2;
  const pillCenterY = canvasHeight / 2;

  let cursorX = pillCenterX - totalWordsWidth / 2;
  const wordCenters = wordWidths.map((w) => {
    const center = cursorX + w / 2;
    cursorX += w + spaceWidth;
    return center;
  });

  // --- Per-word bounce curve (fast, snappy — tighter than a full-phrase pop) ---
  const scaleAt = makeScaleFn({
    popDuration: 0.1,
    settleDuration: 0.12,
    startScale: 0.3,
    overshoot: 1.2,
  });

  const wordStartTimes = words.map((_, i) => i * wordStagger);
  const animationEndTime = wordStartTimes[wordStartTimes.length - 1] + 0.1 + 0.12;

  if (animationEndTime > totalDurationSec) {
    console.warn(
      `⚠️  Word-by-word animation (${animationEndTime.toFixed(2)}s) is longer than totalDurationSec ` +
      `(${totalDurationSec}s) — later words may get cut off. Increase totalDurationSec or wordStagger.`
    );
  }

  const frameOpts = { font, strokeWidth, shadowDX, shadowDY };
  const totalFrames = Math.round(totalDurationSec * fps);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sticker-frames-"));

  try {
    for (let i = 0; i < totalFrames; i++) {
      const t = i / fps;
      const canvas = createCanvas(canvasWidth, canvasHeight);
      const ctx = canvas.getContext("2d");

      // Pill — static, full size, visible from frame 0
      ctx.save();
      ctx.shadowColor = "rgba(0, 0, 0, 0.35)";
      ctx.shadowBlur = 10;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 6;
      ctx.fillStyle = "#ffb02e";
      roundRectPath(
        ctx,
        pillCenterX - pillWidth / 2,
        pillCenterY - pillHeight / 2,
        pillWidth,
        pillHeight,
        pillHeight / 2
      );
      ctx.fill();
      ctx.restore();

      // Each word, staggered
      words.forEach((word, idx) => {
        const localT = t - wordStartTimes[idx];
        const scale = scaleAt(localT);
        drawWord(ctx, word, wordCenters[idx], pillCenterY + 2, scale, frameOpts);
      });

      const framePath = path.join(tmpDir, `frame_${String(i).padStart(4, "0")}.png`);
      fs.writeFileSync(framePath, canvas.toBuffer("image/png"));
    }

    const webmPath = path.join(tmpDir, "sticker.webm");
    await new Promise((resolve, reject) => {
      const ff = spawn(ffmpegPath, [
        "-y",
        "-framerate", String(fps),
        "-i", path.join(tmpDir, "frame_%04d.png"),
        "-c:v", "libvpx-vp9",
        "-pix_fmt", "yuva420p",
        "-auto-alt-ref", "0",
        webmPath,
      ]);
      let stderr = "";
      ff.stderr.on("data", (d) => (stderr += d.toString()));
      ff.on("error", (err) => reject(new Error(`Failed to start ffmpeg at ${ffmpegPath}: ${err.message}`)));
      ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}\n${stderr}`))));
    });

    const uploadResult = await cloudinary.uploader.upload(webmPath, {
      resource_type: "video",
      folder,
      public_id: publicId,
      overwrite: true,
      invalidate: true,
    });

    return uploadResult.public_id;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { generateAnimatedSticker };