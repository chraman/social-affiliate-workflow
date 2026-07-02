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
const GRAPH_API = 'https://graph.facebook.com/v25.0';

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

// ─── Look up affiliate link(s) for a given IG media id ─────────────────────
async function getAffiliateLinksForMedia(igMediaId) {
  const result = await pool.query(`
    SELECT pqi.position, p.outfit_name, p.affiliate_link
    FROM post_queue pq
    JOIN post_queue_items pqi ON pqi.post_queue_id = pq.id
    JOIN products p ON p.id = pqi.product_id
    WHERE pq.ig_media_id = $1
    ORDER BY pqi.position ASC
  `, [igMediaId]);
  return result.rows;
}

function formatLinkReply(items) {
  if (items.length === 0) {
    return "Sorry, couldn't find the link for this one! Drop a message and I'll send it manually 🙏";
  }
  if (items.length === 1) {
    return `Here's the link 🛍️\n${items[0].affiliate_link}`;
  }
  return items
    .map(i => `${i.position}. ${i.outfit_name}\n${i.affiliate_link}`)
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
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // ack immediately, Meta requires fast response
    console.log("in webhook")
  const body = req.body;
console.log(req,res)
  try {
    if (body.object !== 'instagram') return;

    for (const entry of body.entry || []) {
      // ── Comments ──
      for (const change of entry.changes || []) {
        if (change.field === 'comments') {
          const comment = change.value;
          const text = (comment.text || '').toLowerCase();

          if (text.includes('link') || text.includes('price') || text.includes('shop')) {
            const items = await getAffiliateLinksForMedia(comment.media.id);
            const reply = formatLinkReply(items);

            // Public comment reply (keeps it on-platform, but no clickable link works here either)
            await replyToComment(comment.id, "Sent you the link in DM! 💌");

            // Actual link goes via DM (comment-to-DM requires the commenter to have DM'd you before,
            // or use the "private reply" endpoint instead — see note below)
            await axios.post(`${GRAPH_API}/${comment.id}/private_replies`, null, {
              params: { message: reply, access_token: IG_TOKEN }
            });

            console.log(`Replied to comment from media ${comment.media.id}`);
          }
        }
      }

      // ── Direct messages ──
      for (const messagingEvent of entry.messaging || []) {
        const senderId = messagingEvent.sender?.id;
        const messageText = (messagingEvent.message?.text || '').toLowerCase();

        if (senderId && (messageText.includes('link') || messageText.includes('price'))) {
          // Without a referenced post, we don't know which product they mean —
          // fall back to most recently posted item, or ask them to specify.
          const recent = await pool.query(`
            SELECT pqi.position, p.outfit_name, p.affiliate_link
            FROM post_queue pq
            JOIN post_queue_items pqi ON pqi.post_queue_id = pq.id
            JOIN products p ON p.id = pqi.product_id
            WHERE pq.status = 'posted'
            ORDER BY pq.posted_at DESC
            LIMIT 5
          `);
          const reply = formatLinkReply(recent.rows);
          await sendDirectMessage(senderId, reply);
          console.log(`Replied to DM from ${senderId}`);
        }
      }
    }
  } catch (err) {
    console.error('Webhook processing error:', err.response?.data || err.message);
  }
});

const PORT = process.env.WEBHOOK_PORT || 5000;
app.listen(PORT, () => console.log(`📩 IG webhook listening on port ${PORT}`));