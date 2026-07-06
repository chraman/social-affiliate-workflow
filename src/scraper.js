const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');

// Add stealth plugin
chromium.use(stealth());

const SELECTORS = {
  name: 'h1.pdp-name, h1.pdp-title, .pdp-product-description-content h4',
  brand: '.pdp-title h1, h1.pdp-name',
  price: '.pdp-price strong, .pdp-discounted-price strong',
  originalPrice: '.pdp-mrp s, .pdp-price s',
  discount: '.pdp-discount, .pdp-price .discount',
  description: '.pdp-product-description-content, .pdp-product-description',
  rating: '.index-overallRating div:first-child, .detailed-ratings-container h4',
  ratingCount: '.index-ratingsCount, .index-review-count',
  images: 'img.FurnishUI-image--src, .image-grid-image, img.pdp-image',
  sizes: '.size-buttons-buttonContainer .common-customSelect',
};

/**
 * Scrapes a Myntra product URL and returns structured product data.
 * @param {string} url - Myntra product URL
 * @returns {Promise<ProductData>}
 */
async function scrapeMyntraProduct(url) {
  console.log('🕷️  Launching browser...');
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-http2',
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-IN',
    bypassCSP: true, // Helps with some anti-bot scripts
    extraHTTPHeaders: {
      'Accept-Language': 'en-IN,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Referer': 'https://www.google.com/', // Mimic coming from a search engine
    },
  });

  const page = await context.newPage();

  // Mask playwright/puppeteer fingerprint
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  try {
    console.log('🌐 Navigating to:', url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for the main product content to appear
    await page.waitForSelector('h1', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000); // let JS render

    const product = await page.evaluate((SELECTORS) => {
      function qs(selector) {
        return document.querySelector(selector)?.innerText?.trim() || '';
      }

      // Extract product images from background-image style or src
      const imageUrls = [];
      document.querySelectorAll(SELECTORS.images).forEach((el) => {
        const src = el.src || el.getAttribute('src');
        const bg = el.style?.backgroundImage?.match(/url\(["']?(.+?)["']?\)/)?.[1];
        const url = src || bg;
        if (url && !url.includes('placeholder') && !imageUrls.includes(url)) {
          imageUrls.push(url.startsWith('//') ? 'https:' + url : url);
        }
      });

      // Also check image grid (common Myntra pattern)
      document.querySelectorAll('[class*="image-grid"] img').forEach((el) => {
        const src = el.src || el.dataset.src;
        if (src && !src.includes('placeholder') && !imageUrls.includes(src)) {
          imageUrls.push(src);
        }
      });

      // Available sizes
      const sizes = [];
      document
        .querySelectorAll('.size-buttons-buttonContainer button, .size-buttons-unified-buttonContainer button')
        .forEach((btn) => {
          const size = btn.innerText?.trim();
          const isDisabled =
            btn.disabled ||
            btn.classList.contains('size-buttons-strikeThrough') ||
            btn.getAttribute('data-reactid')?.includes('disabled');
          if (size) sizes.push({ size, available: !isDisabled });
        });

      // Rating
      const ratingEl = document.querySelector(
        '.index-overallRating div:first-child, .detailed-ratings-container span'
      );
      const ratingCountEl = document.querySelector(
        '.index-ratingsCount, .index-ratingsCount-count'
      );

      // Price
      const priceEl =
        document.querySelector('.pdp-price strong') ||
        document.querySelector('span.pdp-price strong');
      const mrpEl =
        document.querySelector('.pdp-mrp s') ||
        document.querySelector('.pdp-mrp strong');
      const discountEl = document.querySelector('.pdp-discount, .pdp-percent-discount');

      // Name & brand
      const nameEl =
        document.querySelector('h1.pdp-name') ||
        document.querySelector('h1.pdp-title');
      const brandEl = document.querySelector('.pdp-title h1, .pdp-brand');

      // Description
      const descEls = document.querySelectorAll(
        '.pdp-product-description-content p, .pdp-product-description-content li, ' +
        '.index-tableContainer tbody tr'
      );
      const descParts = [];
      descEls.forEach((el) => {
        const text = el.innerText?.trim();
        if (text && text.length > 2) descParts.push(text);
      });

      return {
        name: nameEl?.innerText?.trim() || document.title,
        brand: brandEl?.innerText?.trim() || '',
        price: Number(priceEl?.innerText?.trim().replace(/[^0-9.-]+/g, "")) || '',
        originalPrice: Number(mrpEl?.innerText?.trim().replace(/[^0-9.-]+/g, "")) || '',
        discount: discountEl?.innerText?.trim() || '',
        rating: ratingEl?.innerText?.trim() || '',
        ratingCount: ratingCountEl?.innerText?.trim() || '',
        description: descParts.join('\n').slice(0, 800),
        images: imageUrls.slice(0, 6),
        sizes,
        url: window.location.href,
      };
    }, SELECTORS);

    // Fallback: try to get images via network requests if page extraction failed
    if (product.images.length === 0) {
      console.warn('⚠️  No images found via DOM, trying meta tags...');
      const metaImages = await page.evaluate(() => {
        const og = document.querySelector('meta[property="og:image"]')?.content;
        return og ? [og] : [];
      });
      product.images = metaImages;
    }

    console.log(
      `✅ Scraped: ${product.name} | ${product.price} | ${product.images.length} images`
    );
    return product;
  } finally {
    await browser.close();
  }
}

module.exports = { scrapeMyntraProduct };
