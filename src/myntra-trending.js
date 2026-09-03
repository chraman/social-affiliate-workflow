#!/usr/bin/env node
/**
 * myntra-trending.js
 *
 * Fetches "trending" product links from Myntra for a given category by
 * parsing the `window.__myx` JSON blob that Myntra's category pages embed
 * server-side. No headless browser needed for the common case.
 *
 * Myntra doesn't expose a literal "trending" sort — the closest proxies are:
 *   popularity  -> Myntra's default "Recommended" sort (best general proxy for trending)
 *   discount    -> highest discount first
 *   newest      -> newest arrivals
 *   priceAsc / priceDesc
 *
 * Usage:
 *   node myntra-trending.js <category-slug> [--limit 30] [--sort popularity]
 *
 * Examples:
 *   node myntra-trending.js men-tshirts
 *   node myntra-trending.js women-dresses --limit 50 --sort discount
 *   node myntra-trending.js men-casual-shoes --sort newest --limit 20
 *
 * Category slugs are just Myntra's URL path, e.g.:
 *   myntra.com/men-tshirts      -> "men-tshirts"
 *   myntra.com/women-dresses    -> "women-dresses"
 *   myntra.com/men-casual-shoes -> "men-casual-shoes"
 *
 * Install:
 *   npm install axios
 *
 * Notes / caveats:
 *  - Myntra sits behind bot-detection. Under load or from datacenter IPs you
 *    may occasionally get a challenge page instead of the real listing —
 *    the script throws a clear error in that case rather than silently
 *    returning garbage. Retrying, slowing down request rate, or routing
 *    through a residential proxy usually resolves it.
 *  - If Myntra changes their SSR structure and `window.__myx` disappears,
 *    you'll need a headless-browser fallback (Puppeteer/Playwright) that
 *    waits for the product grid to render and reads the same underlying
 *    API calls (usually to a `/gateway/v2/search/...` endpoint) instead.
 */

const axios = require('axios');

const BASE_URL = 'https://www.myntra.com';

const SORT_MAP = {
  popularity: 'popularity',
  discount: 'discount',
  priceAsc: 'price_asc',
  priceDesc: 'price_desc',
  newest: 'new',
};

function parseArgs(argv) {
  const rest = argv.slice(2);
  const args = { category: rest[0], limit: 30, sort: 'popularity' };
  for (let i = 1; i < rest.length; i++) {
    if (rest[i] === '--limit') args.limit = parseInt(rest[++i], 10);
    else if (rest[i] === '--sort') args.sort = rest[++i];
  }
  return args;
}

/**
 * Pull the `window.__myx = {...};` JSON blob out of the raw HTML.
 * We walk brace-by-brace instead of using a regex because the JSON itself
 * can contain literal "};" sequences inside string values.
 */
function extractMyxJson(html) {
  const marker = 'window.__myx = ';
  const start = html.indexOf(marker);
  if (start === -1) return null;

  const jsonStart = start + marker.length;
  let depth = 0;
  let end = -1;
  for (let i = jsonStart; i < html.length; i++) {
    const ch = html[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) return null;

  try {
    return JSON.parse(html.slice(jsonStart, end));
  } catch {
    return null;
  }
}

async function fetchCategoryPage(category, sort) {
  const url = `${BASE_URL}/${category}`;
  const { data: html } = await axios.get(url, {
    params: { sort: SORT_MAP[sort] || sort },
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    timeout: 15000,
  });
  return html;
}

function normalizeProducts(myx) {
  const products =
    myx?.searchData?.results?.products || myx?.searchData?.products || [];

  return products.map((p) => ({
    id: p.productId,
    brand: p.brand,
    name: p.product || p.productName,
    price: p.price,
    mrp: p.mrp,
    discountPercent: p.discount,
    rating: p.rating,
    ratingCount: p.ratingCount,
    url: `${BASE_URL}/${p.landingPageUrl}`,
    image: p.searchImage || p.image,
  }));
}

async function getTrendingProducts(
  category,
  { limit = 30, sort = 'popularity' } = {}
) {
  const html = await fetchCategoryPage(category, sort);
  const myx = extractMyxJson(html);

  if (!myx) {
    throw new Error(
      'Could not find embedded product data (window.__myx). Myntra may ' +
        'have changed its page structure, or served a bot-check page ' +
        'instead of the real listing. Try again, or add a headless-' +
        'browser fallback.'
    );
  }

  return normalizeProducts(myx).slice(0, limit);
}

async function main() {
  const { category, limit, sort } = parseArgs(process.argv);
  if (!category) {
    console.error(
      'Usage: node myntra-trending.js <category-slug> [--limit N] ' +
        '[--sort popularity|discount|priceAsc|priceDesc|newest]'
    );
    process.exit(1);
  }

  try {
    const products = await getTrendingProducts(category, { limit, sort });
    if (!products.length) {
      console.error(
        'No products found — double check the category slug ' +
          '(e.g. "men-tshirts", "women-dresses").'
      );
      process.exit(1);
    }
    console.log(JSON.stringify(products, null, 2));
  } catch (err) {
    console.error('Failed:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { getTrendingProducts };