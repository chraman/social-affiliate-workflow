// pipeline.js
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;
const axios = require('axios');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

/**
 * @typedef {Object} Product
 * @property {string} brand
 * @property {string} name
 * @property {string} price
 * @property {string} [originalPrice]
 * @property {string} [discount]
 * @property {string} [rating]
 * @property {string} [ratingCount]
 * @property {Array<{size: string, available: boolean}>} [sizes]
 * @property {string} [description]
 * @property {string} myntraUrl
 * @property {string} [category]
 * @property {number} [priceValue]
 * @property {string} [outfitName]
 * @property {string[]} [imageUrls]
 * @property {number} [id]              // populated after DB insert
 * @property {string} [affiliateLink]   // populated after CueLinks call
 */

// ─── Step 1: affiliate link + DB insert ──────────────────────────────────

// async function getCuelinksAffiliateLink(myntraUrl) {
//   const res = await axios.post('https://www.cuelinks.com/api/v1/deeplinks/generate', {
//     url: myntraUrl
//   }, {
//     headers: { Authorization: `Bearer ${process.env.CUELINKS_API_KEY}` }
//   });
//   return res.data.deeplink; // adjust per actual CueLinks response shape
// }

/**
 * Mutates and returns the same product object with id + affiliateLink attached.
 * @param {Product} product
 * @returns {Promise<Product>}
 */
async function createProduct(product) {
  console.log(product)
  if (!product.myntraUrl) throw new Error('Product missing myntraUrl');

  product.outfitName = product.outfitName || `${product.brand} ${product.name}`;
  product.affiliateLink = product.myntraUrl;

  const result = await pool.query(
    `INSERT INTO products 
      (brand, name, outfit_name, myntra_url, affiliate_link, price, original_price, 
       discount, rating, rating_count, sizes, description, category)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [
      product.brand || null,
      product.name || null,
      product.outfitName,
      product.myntraUrl,
      product.affiliateLink,
      product.price || null,
      product.originalPrice || null,   // add this alongside priceValue — numeric version of originalPrice
      product.discount || null,
      product.rating ? parseFloat(product.rating) : null,
      product.ratingCount ? parseInt(product.ratingCount, 10) : null,
      product.sizes ? JSON.stringify(product.sizes) : null,
      product.description || null,
      product.category || null
    ]
  );

  product.id = result.rows[0].id;
  console.log(`[Step 1] Created product #${product.id}: ${product.outfitName}`);
  return product;
}

function sanitizeFolderName(name) {
  return name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}
// ─── Step 2-3: upload images, attach URLs back to product ───────────────

/**
 * @param {Product} product - must already have product.id from createProduct()
 * @param {string[]} sourceImageUrls
 * @returns {Promise<Product>}
 */
async function uploadImagesForProduct(product, sourceImageUrls) {
  if (!product.id) throw new Error('Product must be saved to DB first (missing id)');

  const folder = `affiliate-pipeline/${sanitizeFolderName(product.outfitName)}`;
  product.imageUrls = [];

  for (const sourceUrl of sourceImageUrls) {
    try {
      // download locally first (script can reach localhost:9000 fine), then push bytes to Cloudinary
      const response = await axios.get(sourceUrl, { responseType: 'arraybuffer' });
      const base64 = `data:image/png;base64,${Buffer.from(response.data).toString('base64')}`;

      const result = await cloudinary.uploader.upload(base64, { folder });

      await pool.query(
        `INSERT INTO product_images (product_id, image_url) VALUES ($1, $2)`,
        [product.id, result.secure_url]
      );

      product.imageUrls.push(result.secure_url);
      console.log(`[Step 2-3] Uploaded: ${result.secure_url}`);
    } catch (err) {
      console.error(`[Step 2-3] Failed to upload ${sourceUrl}: ${err.message}`);
    }
  }

  return product;
}

// ─── Step 4: review ───────────────────────────────────────────────────────

async function getReviewBatch() {
  const result = await pool.query(`
    SELECT p.id AS product_id, p.outfit_name, p.affiliate_link, p.price,
           pi.id AS image_id, pi.image_url, pi.quality_score, pi.selected
    FROM products p
    JOIN product_images pi ON pi.product_id = p.id
    ORDER BY p.id, pi.id
  `);

  const grouped = {};
  for (const row of result.rows) {
    if (!grouped[row.outfit_name]) grouped[row.outfit_name] = [];
    grouped[row.outfit_name].push(row);
  }
  console.log(JSON.stringify(grouped, null, 2));
  return grouped;
}

async function rateImage(imageId, qualityScore, selected) {
  await pool.query(
    `UPDATE product_images SET quality_score = $1, selected = $2 WHERE id = $3`,
    [qualityScore, selected, imageId]
  );
  console.log(`[Step 4] Image #${imageId} rated ${qualityScore}, selected: ${selected}`);
}

// ─── Single entrypoint: scrape result -> fully processed product ─────────

/**
 * Runs Step 1-3 for one product in sequence.
 * @param {Product} scrapedProduct
 * @param {string[]} localImagePaths
 * @returns {Promise<Product>}
 */
async function processProduct(scrapedProduct, localImagePaths) {
  let product = await createProduct(scrapedProduct);
  product = await uploadImagesForProduct(product, localImagePaths);
  return product; // now has id, affiliateLink, imageUrls — ready for formatWhatsAppMessage or Step 5+
}

module.exports = {
  pool,
  createProduct,
  uploadImagesForProduct,
  getReviewBatch,
  rateImage,
  processProduct
};