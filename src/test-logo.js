// test-sticker.js
//
// Overlays a Myntra logo badge onto the base product photo via Cloudinary.
// The logo is uploaded once as its own asset, then applied as an image
// overlay on top of the base image — no canvas/text rendering needed.
//
// npm install cloudinary dotenv

const { v2: cloudinary } = require("cloudinary");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Replace with your Cloudinary public_id (the photo you're stickering)
const publicId = "affiliate-pipeline/strapless-gathered-mini-balloon-dress/ldgesi7klfmxycwzppeh.png";

// Save the Myntra logo (transparent PNG works best) locally at this path
const MYNTRA_LOGO_PATH = "./assets/logo/download.png";

async function uploadLogoIfNeeded() {
  const absoluteLogoPath = path.resolve(MYNTRA_LOGO_PATH);
  console.log("Looking for logo at:", absoluteLogoPath);
  console.log("File exists on disk:", fs.existsSync(absoluteLogoPath));

  if (!fs.existsSync(absoluteLogoPath)) {
    throw new Error(`Myntra logo not found at ${absoluteLogoPath}. Save the logo file there first.`);
  }

  // Upload once with a stable public_id — overwrite so re-runs don't create
  // duplicate assets; invalidate so any CDN cache is cleared on update.
  const result = await cloudinary.uploader.upload(absoluteLogoPath, {
    folder: "sticker-tests/assets",
    public_id: "myntra-logo",
    overwrite: true,
    invalidate: true,
    resource_type: "image",
  });

  return result.public_id;
}

async function testLogoOverlay() {
  try {
    const runId = Date.now(); // guarantees a fresh public_id every run — no stale cache possible

    const logoPublicId = await uploadLogoIfNeeded();

    // Composite the logo onto the base photo
    const transformedUrl = cloudinary.url(publicId, {
      secure: true,
      transformation: [
        { width: 1080, crop: "scale" },
        {
          overlay: logoPublicId.replace(/\//g, ":"),
          width: 200,          // adjust logo size as needed
          crop: "scale",
          gravity: "west",
          y: -400,
          x: 80,              // adjust vertical position as needed
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

testLogoOverlay();