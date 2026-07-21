

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
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-setuid-sandbox']
  });
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'eBatPro Price API', version: '1.4.0' });
});

app.post('/recherche', async (req, res) => {
  const { terme, username, password, api_key } = req.body;
  if (api_key !== API_KEY) return res.status(401).json({ error: 'Clé API invalide' });
  if (!terme || !username || !password) return res.status(400).json({ error: 'Paramètres manquants' });

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // LOGIN
    console.log('[LOGIN] Connexion...');
    await page.goto('https://www.ebatpro.fr/login', { waitUntil: 'networkidle2', timeout: 25000 });
    await new Promise(r => setTimeout(r, 2000));
    await page.waitForSelector('input[name="username"]', { timeout: 8000 });
    await page.click('input[name="username"]', { clickCount: 3 });
    await page.type('input[name="username"]', username, { delay: 40 });
    await page.click('input[name="password"]', { clickCount: 3 });
    await page.type('input[name="password"]', password, { delay: 40 });
    const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
    await page.click('button[type="submit"]');
    await nav;
    await new Promise(r => setTimeout(r, 2000));

    if (page.url().includes('/login')) {
      return res.status(401).json({ error: 'Login échoué' });
    }
    console.log('[LOGIN] Connecté !');

    // RECHERCHE
    console.log('[SEARCH] ' + terme);
    await page.goto('https://www.ebatpro.fr/search?term=' + encodeURIComponent(terme), { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 5000));

    // EXTRACTION - sélecteurs confirmés par analyse HTML réelle
    const produits = await page.evaluate(() => {
      // Cartes racines uniquement - data-qa-id = code produit !
      const cards = [...document.querySelectorAll('div[data-qa-id][class*="ProductCard"]')];

      return cards.slice(0, 10).map(card => {
        const code = card.getAttribute('data-qa-id') || '';
        const brand = card.querySelector('[data-qa-id="product-brand"]')?.textContent?.trim() || '';
        const name = card.querySelector('[data-qa-id="product-name"]')?.textContent?.trim() || '';
        const designation = brand ? brand + ' - ' + name : name;
        const lien = card.querySelector('a[href*="/product/"]')?.getAttribute('href') || '';

        // Extraction prix par label texte (format: "Prix public H.T.\n7 642,00 €")
        let prix_public_ht = null, prix_net_ht = null;
        const lignes = (card.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);

        for (let i = 1; i < lignes.length; i++) {
          // Chercher valeur "7 642,00 €" ou "4 126,68 €"
          const prixMatch = lignes[i].match(/^(\d[\d\s]*,\d{2})\s*€?$/);
          if (prixMatch) {
            const valeur = parseFloat(prixMatch[1].replace(/\s/g, '').replace(',', '.'));
            const label = (lignes[i - 1] || '').toLowerCase();
            if (label.includes('public')) prix_public_ht = valeur;
            else if (label.includes('net')) prix_net_ht = valeur;
          }
        }

        return { code, designation, ref_fabricant: '', prix_public_ht, prix_net_ht, lien };
      }).filter(p => p.code && p.designation);
    });

    console.log('[RESULT] ' + produits.length + ' produits, prix public: ' + produits[0]?.prix_public_ht);
    res.json({ terme_recherche: terme, nb_resultats: produits.length, produits, source: 'eBatPro_live' });

  } catch (error) {
    console.error('[ERROR] ' + error.message);
    res.status(500).json({ error: error.message });
  } finally {
    await browser?.close();
  }
});

app.listen(PORT, () => console.log('eBatPro API v1.4.0 port ' + PORT));
