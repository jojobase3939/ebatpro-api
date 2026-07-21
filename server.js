

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
  res.json({ status: 'ok', service: 'eBatPro Price API', version: '1.3.0' });
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

    // Diagnostique les classes CSS de la page
    const pageInfo = await page.evaluate(() => {
      const classes = new Set();
      document.querySelectorAll('*').forEach(el => {
        if (el.className && typeof el.className === 'string') {
          el.className.split(' ').forEach(c => {
            if (c.length > 2) classes.add(c);
          });
        }
      });
      const cardClasses = [...classes].filter(c =>
        c.toLowerCase().includes('card') ||
        c.toLowerCase().includes('product') ||
        c.toLowerCase().includes('item') ||
        c.toLowerCase().includes('result')
      );
      return {
        cardClasses: cardClasses.slice(0, 30),
        bodyText: document.body.innerText.slice(0, 400),
        totalElements: document.querySelectorAll('*').length
      };
    });

    console.log('[SEARCH] Classes trouvées:', JSON.stringify(pageInfo.cardClasses));

    // Trouver les cartes produit avec les vraies classes CSS
    const produits = await page.evaluate(() => {
      // Chercher avec différents sélecteurs possibles
      let cards = document.querySelectorAll('[class*="ProductCard"]');
      if (!cards.length) cards = document.querySelectorAll('[class*="product-card"], [class*="productCard"], [class*="product_card"]');
      if (!cards.length) cards = document.querySelectorAll('[class*="ItemCard"], [class*="item-card"]');
      if (!cards.length) cards = document.querySelectorAll('article');

      return [...cards].slice(0, 10).map(card => {
        const texte = card.innerText || '';
        const prix = texte.match(/(\d+[,.\s]\d+)\s*€/g) || [];
        return {
          designation: card.querySelector('h2, h3, h4, [class*="title"], [class*="name"]')?.textContent?.trim() || texte.slice(0, 80),
          prix_trouves: prix,
          html_debut: card.outerHTML.slice(0, 300)
        };
      });
    });

    res.json({
      terme_recherche: terme,
      nb_resultats: produits.length,
      produits,
      diagnostic: pageInfo,
      source: 'eBatPro_live'
    });

  } catch (error) {
    console.error('[ERROR] ' + error.message);
    res.status(500).json({ error: error.message });
  } finally {
    await browser?.close();
  }
});

app.listen(PORT, () => console.log('eBatPro API v1.3.0 port ' + PORT));
