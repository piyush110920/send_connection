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
app.use(bodyParser.json({ limit: '2mb' })); // increased limit for longer notes

const PORT = process.env.PORT || 3000;
const HEADLESS = String(process.env.HEADLESS || 'false') === 'true';
const USER_DATA_DIR = process.env.USER_DATA_DIR || './user-data';
const NOTE_TEMPLATE = process.env.NOTE_TEMPLATE || '';
const MAX_PER_RUN = Number(process.env.MAX_PER_RUN || 30);

let cookies = [];
try {
  const c = require('./cookies.json');
  if (Array.isArray(c) && c.length) cookies = c;
} catch (e) {
  // no cookies.json — we'll rely on user-data profile
}

let sentCount = 0;
let busy = false; // simple mutex

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browserInstance = null; // reused browser

async function launchBrowser() {
  if (browserInstance) return browserInstance;
  browserInstance = await puppeteer.launch({
    headless: HEADLESS,
    userDataDir: USER_DATA_DIR,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage'
    ],
    defaultViewport: null,
  });
  return browserInstance;
}

async function tryConnect(page, { profileUrl, note }) {
  await page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: 60000 });

  const alreadyConnected = await page.$x(`//button[contains(normalize-space(.),"Message")] | //span[contains(., "Pending")]`);
  if (alreadyConnected.length) return { success: false, status: 'already_connected_or_pending' };

  let connectBtn = await page.$('button[aria-label*="Connect"]');
  if (!connectBtn) {
    const [btn] = await page.$x(`//button[normalize-space(.)="Connect"] | //span[normalize-space(.)="Connect"]/ancestor::button[1]`);
    if (btn) connectBtn = btn;
  }

  if (!connectBtn) {
    const [more] = await page.$x(`//button[normalize-space(.)="More"] | //button[contains(., "More actions")]`);
    if (more) {
      await more.click();
      await sleep(800);
      const [connectInMenu] = await page.$x(`//div[contains(@role,"menu")]//span[normalize-space(.)="Connect"]`);
      if (connectInMenu) connectBtn = connectInMenu;
    }
  }

  if (!connectBtn) return { success: false, status: 'no_connect_button' };

  try {
    await connectBtn.click();
  } catch (e) {
    try { await page.evaluate(el => el.click(), connectBtn); } catch (e2) {}
  }

  await sleep(randomInt(800, 1600));

  const limitWarning = await page.$x(`//*[contains(., "weekly invitation limit")] | //*[contains(., "You’ve reached the weekly")] | //*[contains(., "You have reached the weekly invite limit")]`);
  if (limitWarning.length) return { success: false, status: 'weekly_limit_reached' };

  if (note && note.trim()) {
    const [addNoteBtn] = await page.$x(`//button[contains(., "Add a note")] | //button[contains(., "Add note")] | //button[contains(., "Add personal message")]`);
    if (addNoteBtn) {
      await addNoteBtn.click();
      await sleep(600);
      const textarea = await page.$('textarea[name="message"]') || await page.$('textarea');
      if (textarea) {
        await textarea.type(note, { delay: randomInt(20, 60) });
      }
      const [sendBtn] = await page.$x(`//button[contains(., "Send now")] | //button[contains(., "Send")]`);
      if (sendBtn) {
        await sendBtn.click();
        await sleep(1000);
        return { success: true, status: 'sent_with_note' };
      } else {
        return { success: false, status: 'send_button_not_found_after_note' };
      }
    }
  }

  const [sendNow] = await page.$x(`//button[contains(., "Send now")] | //button[normalize-space(.)="Send"] | //button[contains(., "Send invitation")]`);
  if (sendNow) {
    await sendNow.click();
    await sleep(800);
    return { success: true, status: 'sent_without_note' };
  }

  return { success: false, status: 'send_button_not_found' };
}

// Health and root endpoints
app.get('/', (req, res) => res.send('✅ LinkedIn Puppeteer service — use POST /sendConnection'));
app.get('/health', (req, res) => res.json({ ok: true, sentCount, busy }));

// Main POST endpoint
app.post('/sendConnection', async (req, res) => {
  if (sentCount >= MAX_PER_RUN) {
    return res.status(429).json({ success: false, status: 'max_per_run_reached' });
  }
  if (busy) return res.status(429).json({ success: false, status: 'service_busy' });

  const { profileUrl, note } = req.body || {};
  if (!profileUrl || !/^https?:\/\/(www\.)?linkedin\.com\/in\//.test(profileUrl)) {
    return res.status(400).json({ success: false, status: 'bad_request', message: 'profileUrl required and must be a linkedin.com/in URL' });
  }

  busy = true;
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');

    if (cookies && cookies.length) {
      try { await page.setCookie(...cookies); } catch (e) { console.warn('Could not set cookies:', e.message || e); }
    }

    await sleep(randomInt(500, 1200));

    const result = await tryConnect(page, { profileUrl, note: note?.trim() ? note : NOTE_TEMPLATE });
    if (result.success) sentCount += 1;

    res.json({ ...result, profileUrl });
  } catch (err) {
    console.error('Error in /sendConnection:', err.stack || err);
    res.status(500).json({ success: false, status: 'exception', error: String(err) });
  } finally {
    busy = false;
    try { if (browser) await page.close(); } catch (e) {}
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 LinkedIn bot running on http://0.0.0.0:${PORT}`);
  console.log(`   HEADLESS=${HEADLESS}  USER_DATA_DIR=${USER_DATA_DIR}`);
});
