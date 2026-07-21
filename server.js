

const express = require('express');
const puppeteer = require('puppeteer-core');

const app = express();
app.use(express.json());

const API_KEY = process.env.API_KEY || 'CHANGER_CETTE_CLE_EN_PROD';
const PORT = process.env.PORT || 3000;
const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

async function launchBrowser() {
  return puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-setuid-sandbox', '--window-size=1280,900']
  });
}

async function fillField(page, selector, value) {
  await page.evaluate((sel, val) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error('Champ non trouvé: ' + sel);
    const nativeInput = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    nativeInput.set.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, selector, value);
}

async function getFormInputs(page) {
  return await page.evaluate(() => {
    return [...document.querySelectorAll('input')].map(i => ({
      type: i.type, name: i.name || null, id: i.id || null,
      placeholder: i.placeholder || null, visible: i.offsetParent !== null,
      className: i.className ? i.className.split(' ')[0] : null
    }));
  });
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'eBatPro Price API', version: '1.2.2' });
});

app.get('/debug-login', async (req, res) => {
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    page.setDefaultTimeout(25000);
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto('https://www.ebatpro.fr/login', { waitUntil: 'networkidle2', timeout: 20000 });
    await new Promise(r => setTimeout(r, 2000));
    const inputs = await getFormInputs(page);
    const pageUrl = page.url();
    const title = await page.title();
    const forms = await page.evaluate(() => {
      return [...document.querySelectorAll('form')].map(f => ({
        action: f.action || null, method: f.method || null, id: f.id || null,
        inputs_count: f.querySelectorAll('input').length,
        buttons: [...f.querySelectorAll('button')].map(b => ({ type: b.type, text: b.textContent.trim().slice(0,50) }))
      }));
    });
    const screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });
    res.json({ url: pageUrl, title, forms, inputs, screenshot_length: screenshot.length, info: 'Champs du formulaire de login eBatPro' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    await browser?.close();
  }
});

app.post('/debug-search', async (req, res) => {
  const { terme, username, password, api_key } = req.body;
  if (api_key !== API_KEY) return res.status(401).json({ error: 'Clé API invalide' });
  if (!terme || !username || !password) return res.status(400).json({ error: 'terme, username, password, api_key requis' });

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await page.goto('https://www.ebatpro.fr/login', { waitUntil: 'networkidle2', timeout: 25000 });
    await new Promise(r => setTimeout(r, 2000));
    await page.waitForSelector('input[name="username"]', { timeout: 8000 });
    await page.click('input[name="username"]', { clickCount: 3 });
    await page.type('input[name="username"]', username, { delay: 40 });
    await page.click('input[name="password"]', { clickCount: 3 });
    await page.type('input[name="password"]', password, { delay:
