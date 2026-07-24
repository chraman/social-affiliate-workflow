const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require("fs");
const path = require("path");

const { scrapeMyntraProduct } = require('./scraper');
const { buildAffiliateLinkCuelinks } = require('./affiliate');
const { formatWhatsAppMessage } = require('./formatter');
const { generateInfluencerImage } = require('./visioncraft');
const createCollage = require("./createCollage");
const { createProduct, uploadImagesForProduct } = require('./pipeline');

const BOT_SIGNATURE = '<!-- bot -->';
const pendingSelections = new Map();

// Helper Logger
const log = (step, chatId, details = "") => {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] [${chatId}] 🟢 ${step}: ${details}`);
};

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
const SELF_CHAT_ID = "124644464017605@lid";
client.on('message_create', async (msg) => {
    // console.log("here", msg)
    const text = msg.body?.trim();
    if (!text || msg.body.includes(BOT_SIGNATURE)) return;
    const chat = await msg.getChat();
    // console.log("here", chat)
    if (chat.name !== 'cheky' && chat.name !=='+91 83760 64139') return;

    const chatId = chat.id._serialized;

    if (pendingSelections.has(chatId)) {
        return handleImageSelection(msg, chat, text);
    }

    const myntraUrl = extractMyntraUrl(text);
    if (myntraUrl) {
        return handleNewProduct(msg, chat, myntraUrl);
    }
});
const categoriesArray = [
    "Ethnic Female Co-ord Set",
    "Midi Dress",
    "Cotton wear saree for everyday",
    "Short Kurti",
    "Suits",
    "Top and shirts",
    "Kurta with Plazzo",
    "One Piece"
]
async function handleNewProduct(msg, chat, url) {
    const chatId = chat.id._serialized;
    log("NEW_LINK", chatId, `Scraping: ${url}`);
    
    try {
        await chat.sendStateTyping();
        const product = await scrapeMyntraProduct(url);
        log("SCRAPE_SUCCESS", chatId, `Product: ${product.name}`);
        
        const affiliateUrl = await buildAffiliateLinkCuelinks(url);
        log("AFFILIATE_READY", chatId, "Link generated");

        product.myntraUrl = url;
        product.affiliateLink = affiliateUrl;
        product.category = categoriesArray[7]
        const dbProduct = await createProduct(product);
        log("DB_SAVED", chatId, `Product #${dbProduct.id} saved`);

        const collageBuffer = await createCollage(product.images);
        const collagePath = path.join(__dirname, "temp_collage.jpg");
        fs.writeFileSync(collagePath, collageBuffer);
        log("COLLAGE_GENERATED", chatId, "Temporary file created");

        await chat.sendMessage(MessageMedia.fromFilePath(collagePath), {
            caption: "📸 Choose image(s) to convert (e.g., 1,3 or 'all'):" + BOT_SIGNATURE
        });

        fs.unlinkSync(collagePath);
        pendingSelections.set(chatId, { product, affiliateUrl });
        log("WAITING_SELECTION", chatId, "Waiting for user input...");
    } catch (err) {
        log("ERROR", chatId, `Scraping failed: ${err.message}`);
        await msg.reply('⚠️ Error fetching product details.');
    }
}

async function handleImageSelection(msg, chat, text) {
    const chatId = chat.id._serialized;
    const pending = pendingSelections.get(chatId);
    const indexes = parseSelection(text, pending.product.images.length);

    log("SELECTION_RECEIVED", chatId, `Indices: ${text}`);

    if (indexes.length === 0) {
        log("INVALID_SELECTION", chatId, text);
        return msg.reply("Invalid selection. Reply with numbers (e.g., 1,2) or 'all'.");
    }

    await chat.sendStateTyping();
    const generatedUrls = [];
    for (const i of indexes) {
        try {
            log("AI_GEN_START", chatId, `Processing image index ${i + 1}`);
            const aiImageUrl = await generateInfluencerImage(pending.product.images[i]);
            
            if (aiImageUrl) {
                log("AI_GEN_SUCCESS", chatId, `Generated index ${i + 1}`);
                generatedUrls.push(aiImageUrl);
                const media = await MessageMedia.fromUrl(aiImageUrl, { unsafeMime: true });
                await chat.sendMessage(media, { caption: `✨ AI Styled Look (${i + 1})` + BOT_SIGNATURE });
            }
        } catch (e) {
            log("AI_GEN_ERROR", chatId, `Failed index ${i + 1}: ${e.message}`);
        }
    }
    await uploadImagesForProduct(pending.product, generatedUrls);
    await msg.reply(formatWhatsAppMessage(pending.product, pending.affiliateUrl) + "\n" + BOT_SIGNATURE);
    pendingSelections.delete(chatId);
    log("FLOW_COMPLETED", chatId, "Session cleared.");
}

const parseSelection = (text, max) => {
    if (text.toLowerCase() === 'all') return Array.from({ length: max }, (_, i) => i);
    return text.split(',').map(x => parseInt(x.trim()) - 1).filter(i => i >= 0 && i < max);
};

const extractMyntraUrl = (text) => text.match(/https?:\/\/(www\.)?myntra\.com\/[^\s]+/i)?.[0];

client.initialize();