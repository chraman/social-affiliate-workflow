/**
 * Formats scraped product data into a clean WhatsApp message.
 *
 * @param {Object} product - scraped product object
 * @param {string} affiliateUrl - CueLinks affiliate URL
 * @returns {string} formatted WhatsApp message
 */
function formatWhatsAppMessage(product, affiliateUrl) {
  const lines = [];

  // Brand + Name
  if (product.brand) {
    lines.push(`*${product.brand}*`);
  }
  if (product.name && product.name !== product.brand) {
    lines.push(`_${product.name}_`);
  }

  lines.push('');

  // Pricing block
  if (product.price) {
    const priceBlock = [`💰 *${product.price}*`];
    if (product.originalPrice && product.originalPrice !== product.price) {
      priceBlock.push(`~${product.originalPrice}~`);
    }
    if (product.discount) {
      priceBlock.push(`🏷️ ${product.discount} off`);
    }
    lines.push(priceBlock.join('  '));
  }

  // Rating
  if (product.rating) {
    const stars = ratingToStars(parseFloat(product.rating));
    const count = product.ratingCount ? ` (${product.ratingCount})` : '';
    lines.push(`⭐ ${product.rating}${count}  ${stars}`);
  }

  // Available sizes
  if (product.sizes && product.sizes.length > 0) {
    const available = product.sizes
      .filter((s) => s.available)
      .map((s) => s.size);
    const unavailable = product.sizes
      .filter((s) => !s.available)
      .map((s) => `~${s.size}~`);
    const allSizes = [...available, ...unavailable];
    if (allSizes.length > 0) {
      lines.push(`📐 Sizes: ${allSizes.join('  ')}`);
    }
  }

  lines.push('');

  // Description (trimmed)
  if (product.description) {
    const shortDesc = trimDescription(product.description, 300);
    lines.push(`📝 *Description*`);
    lines.push(shortDesc);
    lines.push('');
  }

  // Affiliate link CTA
  lines.push(`🛍️ *Buy here:* ${affiliateUrl}`);
  lines.push('');
  lines.push('_Prices & availability may change. Check link for latest._');

  return lines.join('\n');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ratingToStars(rating) {
  const full = Math.round(rating);
  return '★'.repeat(full) + '☆'.repeat(5 - full);
}

function trimDescription(text, maxLength) {
  const cleaned = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');

  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.slice(0, maxLength).trimEnd() + '...';
}

module.exports = { formatWhatsAppMessage };
