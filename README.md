# Myntra WhatsApp Bot

Receives Myntra product links on WhatsApp → scrapes product details + images → replies with description and CueLinks affiliate link.

## Setup

### 1. Install dependencies

```bash
npm install
npx playwright install chromium
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env and add your CUELINKS_API_KEY
```

### 3. Test the scraper first (no WhatsApp needed)

```bash
node src/scraper-test.js "https://www.myntra.com/shirts/your-product-url"
```

You should see the scraped data + formatted message printed in terminal.

### 4. Start the bot

```bash
npm start
```

On first run, a QR code appears in terminal. Open WhatsApp on your phone → Linked Devices → Link a Device → scan it.

After that, auth is saved locally — no QR needed on restart.

### 5. Test it

Send any Myntra product URL to yourself (or to the WhatsApp number that's running the bot). The bot auto-detects the link and replies.

---

## How it works

```
You (WhatsApp) → send Myntra link
     ↓
whatsapp-web.js webhook receives it
     ↓
Playwright headless browser opens the URL
     ↓
Scrapes: name, brand, price, images, sizes, description, rating
     ↓
CueLinks API converts URL → affiliate link
     ↓
Bot replies: product images + formatted message + affiliate link
```

---

## Deployment on Railway

1. Push this folder to a GitHub repo
2. Create a Railway project → Deploy from GitHub
3. Set env vars: `CUELINKS_API_KEY`
4. SSH into Railway shell → run `npm start` once to scan QR
5. After auth, it runs persistently

**Note**: Railway's free tier sleeps after inactivity. Use the $5/month Hobby plan for 24/7.

---

## Troubleshooting

**Myntra not loading**: They update selectors occasionally. Run `scraper-test.js` and check the raw output. Update `SELECTORS` in `scraper.js` if needed.

**QR keeps showing**: Delete `.wwebjs_auth/` folder and re-scan.

**Images not sending**: Myntra CDN images sometimes block hotlinking. The bot skips failed images and continues.

**CueLinks not generating link**: Check your API key and that the domain is registered in your CueLinks dashboard.
