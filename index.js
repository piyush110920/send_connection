// index.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;
const USER_DATA_DIR = process.env.USER_DATA_DIR || './user-data';
const NOTE_TEMPLATE = process.env.NOTE_TEMPLATE || '';
const MAX_PER_RUN = Number(process.env.MAX_PER_RUN || 30);

let cookies = [];
try {
  const c = require('./cookies.json');
  if (Array.isArray(c) && c.length) cookies = c;
} catch (e) {
  // no cookies.json
}

let sentCount = 0;
let busy = false;
let browserInstance = null;

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launchBrowser() {
  if (browserInstance) return browserInstance;

  browserInstance = await puppeteer.launch({
    headless: true, // force headless mode
    userDataDir: USER_DATA_DIR,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
    defaultViewport: null,
  });

  return browserInstance;
}

async function tryConnect(page, { profileUrl, note }) {
  await page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: 60000 });

  // DEBUG LOG before using $x
  console.log('Is page valid?', !!page, typeof page);
  console.log('page keys:', Object.keys(page || {}));

  // Check if already connected
  const alreadyConnected = await page.$x(
    `//button[contains(normalize-space(.),"Message")] | //span[contains(., "Pending")]`
  );
  if (alreadyConnected.length) return { success: false, status: 'already_connected_or_pending' };

  // Find Connect button
  let connectBtn =
    await page.$('button[aria-label*="Connect"]') ||
    (await page.$x(`//button[normalize-space(.)="Connect"] | //span[normalize-space(.)="Connect"]/ancestor::button[1]`))[0];

  if (!connectBtn) {
    const [more] = await page.$x(
      `//button[normalize-space(.)="More"] | //button[contains(., "More actions")]`
    );
    if (more) {
      await more.click();
      await sleep(800);
      const [connectInMenu] = await page.$x(
        `//div[contains(@role,"menu")]//span[normalize-space(.)="Connect"]`
      );
      if (connectInMenu) connectBtn = connectInMenu;
    }
  }

  if (!connectBtn) return { success: false, status: 'no_connect_button' };

  await connectBtn.click().catch(() =>
    page.evaluate((el) => el.click(), connectBtn)
  );
  await sleep(randomInt(800, 1600));

  // Check weekly limit
  const limitWarning = await page.$x(
    `//*[contains(., "weekly invitation limit")] | //*[contains(., "You’ve reached the weekly")]`
  );
  if (limitWarning.length) return { success: false, status: 'weekly_limit_reached' };

  // Add note if available
  if (note?.trim()) {
    const [addNoteBtn] = await page.$x(
      `//button[contains(., "Add a note")] | //button[contains(., "Add note")]`
    );
    if (addNoteBtn) {
      await addNoteBtn.click();
      await sleep(600);

      const textarea = (await page.$('textarea[name="message"]')) || (await page.$('textarea'));
      if (textarea) await textarea.type(note, { delay: randomInt(20, 60) });

      const [sendBtn] = await page.$x(`//button[contains(., "Send now")] | //button[contains(., "Send")]`);
      if (sendBtn) {
        await sendBtn.click();
        await sleep(1000);
        return { success: true, status: 'sent_with_note' };
      }
      return { success: false, status: 'send_button_not_found_after_note' };
    }
  }

  // Send without note
  const [sendNow] = await page.$x(
    `//button[contains(., "Send now")] | //button[normalize-space(.)="Send"] | //button[contains(., "Send invitation")]`
  );
  if (sendNow) {
    await sendNow.click();
    await sleep(800);
    return { success: true, status: 'sent_without_note' };
  }

  return { success: false, status: 'send_button_not_found' };
}

// Routes
app.get('/', (req, res) => res.send('✅ LinkedIn Puppeteer service running'));
app.get('/health', (req, res) => res.json({ ok: true, sentCount, busy }));

app.post('/sendConnection', async (req, res) => {
  if (sentCount >= MAX_PER_RUN) {
    return res.status(429).json({ success: false, status: 'max_per_run_reached' });
  }
  if (busy) return res.status(429).json({ success: false, status: 'service_busy' });

  const { profileUrl, note } = req.body || {};
  if (!profileUrl || !/^https?:\/\/(www\.)?linkedin\.com\/in\//.test(profileUrl)) {
    return res.status(400).json({ success: false, status: 'bad_request', message: 'Valid LinkedIn profile URL required' });
  }

  busy = true;
  let page;
  try {
    const browser = await launchBrowser();
    page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
    );

    if (cookies.length) {
      await page.setCookie(...cookies).catch((e) => console.warn('Cookie set failed:', e.message));
    }

    await sleep(randomInt(500, 1200));
    const result = await tryConnect(page, { profileUrl, note: note?.trim() || NOTE_TEMPLATE });
    if (result.success) sentCount += 1;

    res.json({ ...result, profileUrl });
  } catch (err) {
    console.error('❌ Error in /sendConnection:', err.stack || err);
    res.status(500).json({ success: false, status: 'exception', error: String(err) });
  } finally {
    busy = false;
    if (page) await page.close().catch(() => {});
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 LinkedIn bot running at http://0.0.0.0:${PORT}`);
  console.log(`   HEADLESS=true  USER_DATA_DIR=${USER_DATA_DIR}`);
});
