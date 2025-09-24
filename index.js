// index.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;
const USERNAME = process.env.LINKEDIN_USERNAME;
const PASSWORD = process.env.LINKEDIN_PASSWORD;
const NOTE_TEMPLATE = process.env.NOTE_TEMPLATE || '';
const USER_DATA_DIR = process.env.USER_DATA_DIR || './user-data';
const MAX_PER_RUN = Number(process.env.MAX_PER_RUN || 30);

let sentCount = 0;
let busy = false;
let browserInstance = null;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// Launch Puppeteer browser
async function launchBrowser() {
  if (browserInstance) return browserInstance;

  browserInstance = await puppeteer.launch({
    headless: true,
    userDataDir: USER_DATA_DIR,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080'
    ],
    defaultViewport: null,
  });

  return browserInstance;
}

// Login LinkedIn
async function loginLinkedIn(page) {
  await page.goto('https://www.linkedin.com/login', { waitUntil: 'networkidle2' });

  if (!(await page.$('input#username')) || !(await page.$('input#password'))) {
    console.log('⚠ Already logged in or login inputs not found');
    return;
  }

  await page.type('input#username', USERNAME, { delay: randomInt(50, 100) });
  await page.type('input#password', PASSWORD, { delay: randomInt(50, 100) });

  await page.click('button[type="submit"]');
  await page.waitForNavigation({ waitUntil: 'networkidle2' });

  console.log('✅ Logged into LinkedIn successfully');
}

// Send connection request
async function sendConnection(page, profileUrl, note) {
  await page.goto(profileUrl, { waitUntil: 'networkidle2' });
  console.log('Navigated to profile:', profileUrl);

  const messageText = String(note || NOTE_TEMPLATE);

  // Already connected check
  const alreadyConnected = await page.$x(
    `//button[contains(normalize-space(.),"Message")] | //span[contains(., "Pending")]`
  );
  if (alreadyConnected.length) return { success: false, status: 'already_connected_or_pending' };

  // Find Connect button
  let connectBtn =
    await page.$('button[aria-label*="Connect"]') ||
    (await page.$x(`//button[normalize-space(.)="Connect"] | //span[normalize-space(.)="Connect"]/ancestor::button[1]`))[0];

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

  await connectBtn.click().catch(() => page.evaluate(el => el.click(), connectBtn));
  await sleep(randomInt(800, 1600));

  // Add note if provided
  if (messageText.length > 0) {
    const [addNoteBtn] = await page.$x(`//button[contains(., "Add a note")] | //button[contains(., "Add note")]`);
    if (addNoteBtn) {
      await addNoteBtn.click();
      await sleep(600);

      const textarea = (await page.$('textarea[name="message"]')) || (await page.$('textarea'));
      if (textarea) await textarea.type(messageText, { delay: randomInt(20, 60) });

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
  const [sendNow] = await page.$x(`//button[contains(., "Send now")] | //button[normalize-space(.)="Send"] | //button[contains(., "Send invitation")]`);
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
  if (sentCount >= MAX_PER_RUN) return res.status(429).json({ success: false, status: 'max_per_run_reached' });
  if (busy) return res.status(429).json({ success: false, status: 'service_busy' });

  const profileUrl = String(req.body?.profileUrl || '');
  const noteText = String(req.body?.note || NOTE_TEMPLATE);

  if (!profileUrl || !/^https?:\/\/(www\.)?linkedin\.com\/in\//.test(profileUrl)) {
    return res.status(400).json({ success: false, status: 'bad_request', message: 'Valid LinkedIn profile URL required' });
  }

  busy = true;
  let page;
  try {
    const browser = await launchBrowser();
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');

    // Login if login form is present
    if (await page.$('input#username') && await page.$('input#password')) {
      await loginLinkedIn(page);
    }

    const result = await sendConnection(page, profileUrl, noteText);
    if (result.success) sentCount += 1;

    res.json({ ...result, profileUrl, timestamp: new Date().toISOString() });
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
});
