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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// Launch Puppeteer safely
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
            '--single-process',
            '--disable-blink-features=AutomationControlled',
        ],
        defaultViewport: null,
    });

    if (!browserInstance.newPage) {
        throw new Error('Browser launch failed, newPage not available');
    }

    return browserInstance;
}

// Login function
async function loginLinkedIn(page) {
    console.log('🔑 Logging into LinkedIn...');
    await page.goto('https://www.linkedin.com/login', { waitUntil: 'networkidle2', timeout: 60000 });
    await page.type('input#username', USERNAME, { delay: randomInt(50, 100) });
    await page.type('input#password', PASSWORD, { delay: randomInt(50, 100) });
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });
    console.log('✅ Logged in successfully');
}

// Send connection request
async function sendConnection(page, profileUrl, note) {
    if (!page || typeof page.$x !== 'function') throw new Error('Invalid Page object');

    const noteText = typeof note === 'string' ? note.trim() : '';

    await page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    console.log('📄 Navigated to profile:', profileUrl);

    // Check if already connected
    let alreadyConnected = [];
    try {
        alreadyConnected = await page.$x(
            `//button[contains(normalize-space(.),"Message")] | //span[contains(., "Pending")]`
        );
    } catch (err) {
        console.error('❌ $x failed:', err);
        return { success: false, status: 'xpath_failed' };
    }
    if (alreadyConnected.length) return { success: false, status: 'already_connected_or_pending' };

    // Find Connect button
    let connectBtn =
        (await page.$('button[aria-label*="Connect"]')) ||
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
    if (noteText.length > 0) {
        const [addNoteBtn] = await page.$x(`//button[contains(., "Add a note")] | //button[contains(., "Add note")]`);
        if (addNoteBtn) {
            await addNoteBtn.click();
            await sleep(600);
            const textarea = (await page.$('textarea[name="message"]')) || (await page.$('textarea'));
            if (textarea) await textarea.type(noteText, { delay: randomInt(20, 60) });
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

    const { profileUrl, note } = req.body || {};
    if (!profileUrl || !/^https?:\/\/(www\.)?linkedin\.com\/in\//.test(profileUrl)) {
        return res.status(400).json({ success: false, status: 'bad_request', message: 'Valid LinkedIn profile URL required' });
    }

    busy = true;
    let page;
    try {
        const browser = await launchBrowser();
        page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');

        // Check login
        const header = await page.$('header');
        if (!header) await loginLinkedIn(page);

        const result = await sendConnection(page, profileUrl, note?.trim() || NOTE_TEMPLATE);
        if (result.success) sentCount += 1;

        res.json({ ...result, profileUrl });
    } catch (err) {
        console.error('❌ Error in /sendConnection:', err.stack || err);
        res.status(500).json({ success: false, status: 'exception', error: String(err) });
        
        // Key change: In case of an error, set browserInstance to null
        // so the next request starts a new, clean browser.
        browserInstance = null;
    } finally {
        busy = false;
        if (page) await page.close().catch(() => {});
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 LinkedIn bot running at http://0.0.0.0:${PORT}`);
});