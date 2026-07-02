/**
 * Run this first to test the scraper before setting up WhatsApp:
 *   node src/scraper-test.js <myntra-url>
 *
 * Example:
 *   node src/scraper-test.js "https://www.myntra.com/shirts/..."
 */

const { scrapeMyntraProduct } = require('./scraper');
const { formatWhatsAppMessage } = require('./formatter');

const url = process.argv[2];

if (!url) {
  console.error('Usage: node src/scraper-test.js <myntra-url>');
  process.exit(1);
}

(async () => {
  console.log('Testing scraper for:', url);
  console.log('─'.repeat(60));

  try {
    const product = await scrapeMyntraProduct(url);

    console.log('\n📦 RAW SCRAPED DATA:');
    console.log(JSON.stringify(product, null, 2));

    console.log('\n📱 FORMATTED WHATSAPP MESSAGE:');
    console.log('─'.repeat(60));
    const msg = formatWhatsAppMessage(product, url + '?ref=test_affiliate');
    console.log(msg);
  } catch (err) {
    console.error('Scrape failed:', err.message);
    process.exit(1);
  }
})();
