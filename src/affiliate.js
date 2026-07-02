const axios = require('axios');
require('dotenv').config();

const CUELINKS_API = 'https://cl-api.cuetag.in/api/shortUrl';

/**
 * Converts a Myntra URL into a CueLinks affiliate tracking URL.
 * Falls back to original URL if CueLinks API fails.
 *
 * @param {string} originalUrl
 * @returns {Promise<string>} affiliate URL
 */
async function buildAffiliateLinkCuelinks(originalUrl) {
  const apiKey = process.env.CUELINKS_API_KEY;

  if (!apiKey) {
    console.warn('⚠️  CUELINKS_API_KEY not set — returning original URL');
    return originalUrl;
  }

  try {
    const response = await axios.post(
      CUELINKS_API,
      { url: originalUrl },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        timeout: 8000,
      }
    );

    const affiliateUrl =
      response.data?.short_url ||
      response.data?.data?.short_url ||
      response.data?.url;

    if (affiliateUrl) {
      console.log('🔗 Affiliate link:', affiliateUrl);
      return affiliateUrl;
    }

    console.warn('⚠️  CueLinks returned unexpected response:', response.data);
    return originalUrl;
  } catch (err) {
    console.error('❌ CueLinks API error:', err.message);
    return originalUrl; // graceful fallback
  }
}

/**
 * Alternative: build a CueLinks tracking URL without an API call
 * (uses CueLinks redirect pattern — check your dashboard for your Publisher ID)
 *
 * @param {string} originalUrl
 * @param {string} publisherId - your CueLinks publisher ID
 */
function buildAffiliateLinkDirect(originalUrl, publisherId) {
  const encoded = encodeURIComponent(originalUrl);
  return `https://clnk.in/track?pid=${publisherId}&url=${encoded}`;
}

module.exports = { buildAffiliateLinkCuelinks, buildAffiliateLinkDirect };
