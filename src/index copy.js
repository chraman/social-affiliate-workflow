const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { scrapeMyntraProduct } = require('./scraper');
const { buildAffiliateLinkCuelinks } = require('./affiliate');
const { formatWhatsAppMessage } = require('./formatter');
const { cache } = require('./cache');
const { generateInfluencerImage, imageUrlToBase64 } = require('./visioncraft');
const fs = require("fs");
const path = require("path");
const createCollage = require("./createCollage");

const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'myntra-bot' }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  },
});

// ─── QR Scan (first run only) ────────────────────────────────────────────────
client.on('qr', (qr) => {
  console.log('\n📱 Scan this QR code in WhatsApp > Linked Devices:\n');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => console.log('✅ WhatsApp authenticated'));
client.on('ready', () => console.log('🟢 Bot is ready and listening...\n'));

// Add this constant at the top
const BOT_SIGNATURE = '<!-- bot -->';

const pendingSelections = new Map();

// ─── Incoming message handler ─────────────────────────────────────────────────
client.on('message_create', async (msg) => {
  console.log('📨 Message received:', msg.body, '| fromMe:', msg.fromMe);
    const chat1 = await msg.getChat();

    console.log({
        chatId: chat1.id._serialized,
        chatName: chat1.name,
        isGroup: chat1.isGroup,
        from: msg.from,
        to: msg.to,
        fromMe: msg.fromMe
    });
  const text = msg.body?.trim();
  if (!text) return;
  // Only process  if:
  // - message is FROM you (self-sent to Saved Messages), AND
  // - it contains a Myntra URL (not a reply the bot just sent)
  if (chat1.name!='cheky') return;

  if (msg.body?.includes(BOT_SIGNATURE)) return;

  const chatId = chat1.id._serialized;

  if (pendingSelections.has(chatId)) {

    const pending = pendingSelections.get(chatId);

    let indexes = [];

    if (text.toLowerCase() === "all") {

        indexes = pending.product.images.map((_, i) => i);

    } else {

        indexes = text
            .split(",")
            .map(x => parseInt(x.trim(), 10) - 1)
            .filter(i =>
                !isNaN(i) &&
                i >= 0 &&
                i < pending.product.images.length
            );
    }

    if (!indexes.length) {
        await msg.reply(
        `Please reply with:

        1
        2
        1,3
        all`
        );

        return;
    }

    await chat1.sendStateTyping();

    for (const index of indexes) {

        try {

            const result = await generateInfluencerImage(
                pending.product.images[index]
            );

            if (!result) continue;

            const media = await MessageMedia.fromUrl(result, {
                unsafeMime: true
            });

            await chat1.sendMessage(media, {
                caption: `✨ AI Styled Look (${index + 1})`
            });

            await sleep(500);

        } catch (e) {

            console.log(e);

        }

    }

    const reply = formatWhatsAppMessage(
        pending.product,
        pending.affiliateUrl
    );

    await msg.reply(reply + "\n" + BOT_SIGNATURE);

    pendingSelections.delete(chatId);

    return;
  }
  const myntraUrl = extractMyntraUrl(text);
  if (!myntraUrl) return; // ignore non-Myntra messages

  const chat = await msg.getChat();
  console.log(`\n🔗 Myntra link received: ${myntraUrl}`);

  try {
    await chat.sendStateTyping();

    // Check cache first
    // const cached = await cache.get(myntraUrl);
    const product = await scrapeMyntraProduct(myntraUrl);

    // if (!cached) await cache.set(myntraUrl, product);

    // Build affiliate link
    const affiliateUrl = await buildAffiliateLinkCuelinks(myntraUrl);

    // Create collage
    const collageBuffer = await createCollage(product.images.slice(0, 4));

    const collagePath = path.join(__dirname, "temp_collage.jpg");

    fs.writeFileSync(collagePath, collageBuffer);

    const collageMedia = MessageMedia.fromFilePath(collagePath);

    await chat.sendMessage(collageMedia, {
        caption:
    `📸 Choose image(s) to convert to AI.

    Examples:
    1
    2
    1,3
    all`
    });

    fs.unlinkSync(collagePath);

    // Save product for next reply
    pendingSelections.set(chat.id._serialized, {
        product,
        affiliateUrl
    });

    return;
    // Send product images (up to 3)
    const imagesToSend = product.images.slice(0, 3);
    for (let i = 0; i < imagesToSend.length; i++) {
      try {
        const result = await generateInfluencerImage(imagesToSend[i]);
        console.log(result)
        if (result) {
          try {
            const aiMedia = await MessageMedia.fromUrl(result, { unsafeMime: true });
            await msg.reply(aiMedia, undefined, { caption: '✨ AI Styled Look' });
          } catch(err) {
            console.warn(`⚠️  Could not send image ${i + 1}:`, err.message);
          }
        }
        const caption = i === 0 ? product.name : '';
        await sleep(500); // small delay between images
      } catch (imgErr) {
        console.warn(`⚠️  Could not send image ${i + 1}:`, imgErr.message);
      }
    }

    // Send text description + affiliate link
    const reply = formatWhatsAppMessage(product, affiliateUrl);
    await msg.reply(reply + '\n' + BOT_SIGNATURE);

    console.log(`✅ Replied for: ${product.name}`);
  } catch (err) {
    console.error('❌ Error processing Myntra link:', err.message);
    await msg.reply(
      '⚠️ Sorry, could not fetch product details. The link might be invalid or Myntra is blocking the request. Try again in a moment.'
    );
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function extractMyntraUrl(text) {
  const match = text.match(
    /https?:\/\/(www\.)?myntra\.com\/[^\s]+/i
  );
  return match ? match[0] : null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Start ────────────────────────────────────────────────────────────────────
client.initialize();
