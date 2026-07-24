/**
 * Builds a Myntra affiliate link by stripping any existing query params
 * off the product URL and attaching our own affiliate tracking params.
 */

const AFFILIATE_PARAMS = {
  utm_source: 'ugc_affiliate',
  utm_medium: 'social_share_pdp',
  utm_campaign: 'vDS35zK69O',
  shared: 'true',
  affiliate_id: 'vDS35zK69O',
};

/**
 * Converts a Myntra product URL into our own affiliate tracking URL by
 * dropping whatever query params it already has and attaching ours.
 * Falls back to the original URL if it can't be parsed.
 *
 * @param {string} originalUrl
 * @returns {string} affiliate URL
 */
function buildAffiliateLink(originalUrl) {
  if (!originalUrl) return originalUrl;

  try {
    const url = new URL(originalUrl);

    // Remove all existing query params.
    url.search = '';

    // Attach our affiliate params.
    for (const [key, value] of Object.entries(AFFILIATE_PARAMS)) {
      url.searchParams.set(key, value);
    }

    const affiliateUrl = url.toString();
    console.log('🔗 Affiliate link:', affiliateUrl);
    return affiliateUrl;
  } catch (err) {
    console.error('❌ Failed to build affiliate link:', err.message);
    return originalUrl; // graceful fallback
  }
}

module.exports = {
  buildAffiliateLink,
  // Aliases kept so existing call sites don't need to change their imports.
  buildAffiliateLinkCuelinks: buildAffiliateLink,
  buildAffiliateLinkDirect: buildAffiliateLink,
};