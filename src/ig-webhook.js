const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
require('dotenv').config();

// Add request logging
axios.interceptors.request.use(request => {
  console.log(`[${new Date().toISOString()}] 📤 API Request:`, {
    url: request.url,
    method: request.method,
    params: request.params
  });
  return request;
});

// Add response logging
axios.interceptors.response.use(
  response => {
    console.log(`[${new Date().toISOString()}] ✅ API Response:`, {
      status: response.status,
      data: response.data
    });
    return response;
  },
  error => {
    // Log detailed error information
    console.error(`[${new Date().toISOString()}] ❌ API Error:`, {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data // This will show the specific Meta/Instagram error
    });
    return Promise.reject(error);
  }
);

const app = express();
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const IG_TOKEN = process.env.IG_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.IG_WEBHOOK_VERIFY_TOKEN; // you choose this string, set it in Meta App dashboard too
const GRAPH_API = process.env.IG_WORKER_URL;

// ─── Webhook verification (Meta calls this once when you set up the webhook) ───
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ─── Instagram Business Login (one-time OAuth setup) ───────────────────────
// Visit this URL once (logged in as your business IG account) to authorize:
//   https://www.instagram.com/oauth/authorize?enable_fb_login=0&force_authentication=1
//     &client_id=<IG_APP_ID>&redirect_uri=<this server's /auth/callback URL>
//     &response_type=code&scope=instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments
// Instagram redirects back here with ?code=..., which gets exchanged for a
// long-lived token. Copy the printed token into .env as IG_ACCESS_TOKEN.
const IG_APP_ID = process.env.IG_APP_ID;
const IG_APP_SECRET = process.env.IG_APP_SECRET;
const REDIRECT_URI = process.env.IG_OAUTH_REDIRECT_URI; // e.g. https://your-tunnel-domain/auth/callback

app.get('/auth/callback', async (req, res) => {
  const { code, error, error_description } = req.query;
  if (error) return res.status(400).send(`Auth error: ${error_description || error}`);
  if (!code) return res.status(400).send('No code received in the redirect — check the redirect_uri matches exactly what you registered.');

  try {
    // Step 1: exchange code for short-lived token
    const params = new URLSearchParams();
    params.append('client_id', IG_APP_ID);
    params.append('client_secret', IG_APP_SECRET);
    params.append('grant_type', 'authorization_code');
    params.append('redirect_uri', REDIRECT_URI);
    params.append('code', code);

    const shortRes = await axios.post('https://api.instagram.com/oauth/access_token', params);
    const shortLivedToken = shortRes.data.access_token;
    const igUserId = shortRes.data.user_id;

    // Step 2: exchange short-lived for a long-lived token (~60 days)
    const longRes = await axios.get('https://graph.instagram.com/access_token', {
      params: {
        grant_type: 'ig_exchange_token',
        client_secret: IG_APP_SECRET,
        access_token: shortLivedToken
      }
    });

    console.log('✅ IG Business Login complete');
    console.log('IG User ID:', igUserId);
    console.log('Long-lived token:', longRes.data.access_token);
    console.log('Expires in (seconds):', longRes.data.expires_in);

    res.send('Success! Check your server console for the token — copy it into .env as IG_ACCESS_TOKEN, then restart ig-worker.js and ig-webhook.js.');
  } catch (err) {
    console.error('Token exchange failed:', err.response?.data || err.message);
    res.status(500).send('Token exchange failed — check server logs.');
  }
});

// ─── Look up affiliate link(s) for a given IG media id ─────────────────────
// Reads through post_queue_item_products rather than post_queue_items.product_id
// directly, since one item (e.g. a combined video) can now represent several products.
async function getAffiliateLinksForMedia(igMediaId) {
  const result = await pool.query(`
    SELECT pqi.position, pqip.display_order, p.outfit_name, p.affiliate_link
    FROM post_queue pq
    JOIN post_queue_items pqi ON pqi.post_queue_id = pq.id
    JOIN post_queue_item_products pqip ON pqip.post_queue_item_id = pqi.id
    JOIN products p ON p.id = pqip.product_id
    WHERE pq.ig_media_id = $1
    ORDER BY pqi.position ASC, pqip.display_order ASC
  `, [igMediaId]);
  return result.rows;
}

function formatLinkReply(items) {
  if (items.length === 0) {
    return "Sorry, couldn't find the link for this one! Drop a message and I'll send it manually 🙏";
  }

  // group rows by carousel position — a single position (e.g. one combined
  // video slot) can now carry more than one product/link
  const byPosition = new Map();
  for (const row of items) {
    if (!byPosition.has(row.position)) byPosition.set(row.position, []);
    byPosition.get(row.position).push(row);
  }
  const positions = [...byPosition.keys()].sort((a, b) => a - b);

  // single post item overall (no carousel) — just list its product(s) directly
  if (positions.length === 1) {
    const products = byPosition.get(positions[0]);
    if (products.length === 1) {
      return `Here's the link 🛍️\n${products[0].affiliate_link}`;
    }
    return products
      .map((p, i) => `${i + 1}. ${p.outfit_name}\n${p.affiliate_link}`)
      .join('\n\n');
  }

  // multi-item carousel — one numbered line per position; a position that's
  // itself a multi-product combined video lists its products underneath
  return positions
    .map(pos => {
      const products = byPosition.get(pos);
      if (products.length === 1) {
        return `${pos}. ${products[0].outfit_name}\n${products[0].affiliate_link}`;
      }
      return `${pos}. ${products.map(p => p.outfit_name).join(' + ')}\n` +
        products.map(p => p.affiliate_link).join('\n');
    })
    .join('\n\n');
}

// ─── Send a DM reply via Instagram Messaging API ────────────────────────────
async function sendDirectMessage(recipientId, text) {
  await axios.post(`${GRAPH_API}/me/messages`, {
    recipient: { id: recipientId },
    message: { text }
  }, {
    params: { access_token: IG_TOKEN }
  });
}

// ─── Reply to a comment (public reply, optional alongside DM) ──────────────
async function replyToComment(commentId, text) {
  await axios.post(`${GRAPH_API}/${commentId}/replies`, null, {
    params: { message: text, access_token: IG_TOKEN }
  });
}

// ─── Main webhook handler ───────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const body = req.body;
  console.log(body);

  try {
    switch (body.event) {
      case "comment.received": {
        if(body.comment.isReply) {
          console.log("Ignoring reply");
          return;
        }
        if(body.comment.author.username === "shopthelook.daily") {
          console.log("Ignoring own comment");
          return;
        }
        const comment = body.comment;
        const text = (comment.text || "").toLowerCase();

        if (
          text.toLowerCase().includes("link") ||
          text.toLowerCase().includes("price") ||
          text.toLowerCase().includes("shop")
        ) {
          // platformPostId is your Instagram media id
          const mediaId = comment.platformPostId;
          console.log()
          const items = await getAffiliateLinksForMedia(mediaId);
          console.log(items)

          if (!items.length) {
            console.log(`No products found for media ${mediaId}`);
            return;
          }

          const reply = formatLinkReply(items);
          console.log(reply)
          // Public reply
          await replyToComment(
            comment.id,
            "Sent you the link in DM! 💌"
          );

          // Send private DM
          await axios.post(
            `${GRAPH_API}/${comment.author.id}/messages`,
            null,
            {
              params: {
                message: reply,
                access_token: IG_TOKEN,
              },
            }
          );

          console.log(
            `Processed comment ${comment.id} on media ${mediaId}`
          );
        }

        break;
      }

      case "message.received": {
        const message = body.message;

        const senderId = message.author.id;
        const text = (message.text || "").toLowerCase();

        if (
          text.includes("link") ||
          text.includes("price")
        ) {
          const recent = await pool.query(`
            SELECT
              pqi.position,
              pqip.display_order,
              p.outfit_name,
              p.affiliate_link
            FROM post_queue pq
            JOIN post_queue_items pqi
              ON pqi.post_queue_id = pq.id
            JOIN post_queue_item_products pqip
              ON pqip.post_queue_item_id = pqi.id
            JOIN products p
              ON p.id = pqip.product_id
            WHERE pq.status = 'posted'
            ORDER BY
              pq.posted_at DESC,
              pqi.position ASC,
              pqip.display_order ASC
            LIMIT 5
          `);

          const reply = formatLinkReply(recent.rows);

          await sendDirectMessage(senderId, reply);

          console.log(`Replied to DM from ${senderId}`);
        }

        break;
      }

      default:
        console.log(`Ignoring event: ${body.event}`);
    }
  } catch (err) {
    console.error(
      "Webhook processing error:",
      err.response?.data || err.message
    );
  }
});

const PORT = process.env.WEBHOOK_PORT || 5000;
app.listen(PORT, () => console.log(`📩 IG webhook listening on port ${PORT}`));