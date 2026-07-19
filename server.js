const express = require('express');
const puppeteer = require('puppeteer-core');

const app = express();
app.use(express.json());

const API_KEY = process.env.API_KEY || 'CHANGER_CETTE_CLE_EN_PROD';
const PORT = process.env.PORT || 3000;
const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'eBatPro Price API', version: '1.1.0' });
});

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

async function findFirstTextInput(page) {
  return await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input')]
      .filter(i => !['hidden','password','submit','button','checkbox','radio'].includes(i.type))
      .filter(i => i.offsetParent !== null);
    return inputs[0]?.name || inputs[0]?.id || null;
  });
}

app.post('/recherche', async (req, res) => {
  const { terme, username, password, api_key } = req.body;
  if (api_key !== API_KEY) return res.status(401).json({ error: 'Clé API invalide' });
  if (!terme || !username || !password) return res.status(400).json({ error: 'Paramètres manquants' });

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(25000);
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await page.goto('https://www.ebatpro.fr/login', { waitUntil: 'networkidle2', timeout: 20000 });

    const firstInputName = await findFirstTextInput(page);
    console.log(`[LOGIN] Champ trouvé: ${firstInputName}`);

    const userSelector = firstInputName ? `input[name="${firstInputName}"]` : 'input[type="text"]';
    await fillField(page, userSelector, username);
    await fillField(page, 'input[type="password"]', password);

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }),
      page.click('button[type="submit"]')
    ]);

    if (page.url().includes('/login')) {
      await browser.close();
      return res.status(401).json({ error: 'Login échoué - vérifier identifiant/mot de passe', champ: firstInputName });
    }

    await page.goto(`https://www.ebatpro.fr/search?term=${encodeURIComponent(terme)}`, { waitUntil: 'domcontentloaded' });

    try {
      await page.waitForSelector('[class*="ProductCard"][class*="__ProductCard"]', { timeout: 12000 });
    } catch {
      await browser.close();
      return res.json({ terme_recherche: terme, nb_resultats: 0, produits: [] });
    }

    const produits = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[class*="ProductCard"][class*="__ProductCard"]')];
      return cards.slice(0, 10).map(card => {
        const designation = card.querySelector('[class*="text-heading"], h2, h3')?.textContent?.trim() || '';
        const refs = [...card.querySelectorAll('[class*="text-annotation"]')].map(el => el.textContent.trim());
        const code = refs.find(r => /^[A-Z]\d{3,}/.test(r)) || refs[0] || '';
        const ref_fabricant = refs.find(r => r !== code) || '';
        let prix_public_ht = null, prix_net_ht = null;
        [...card.querySelectorAll('[class*="text-price"]')].forEach(el => {
          const val = parseFloat((el.innerText || '').replace(/\s/g, '').replace(',', '.').replace(/[^\d.]/g, '')) || null;
          const label = (el.previousElementSibling?.textContent || '').toLowerCase();
          if (label.includes('public')) prix_public_ht = val;
          else if (label.includes('net')) prix_net_ht = val;
          else if (!prix_public_ht && val) prix_public_ht = val;
        });
        const lien = card.querySelector('a[href*="/product/"]')?.getAttribute('href') || '';
        return { designation, code, ref_fabricant, prix_public_ht, prix_net_ht, lien };
      }).filter(p => p.code || p.designation);
    });

    res.json({ terme_recherche: terme, nb_resultats: produits.length, produits, source: 'eBatPro_live' });

  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    await browser?.close();
  }
});

app.listen(PORT, () => console.log(`✅ eBatPro API port ${PORT}`));
