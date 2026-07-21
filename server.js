
const express = require('express');
const puppeteer = require('puppeteer-core');

const app = express();
app.use(express.json());

const API_KEY = process.env.API_KEY || 'CHANGER_CETTE_CLE_EN_PROD';
const PORT = process.env.PORT || 3000;
const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

// ── Helpers ────────────────────────────────────────────────────────────────────

async function launchBrowser() {
  return puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-setuid-sandbox', '--window-size=1280,900']
  });
}

// Remplit un champ compatible React/Next.js
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

// Récupère les infos de tous les champs du formulaire
async function getFormInputs(page) {
  return await page.evaluate(() => {
    return [...document.querySelectorAll('input')].map(i => ({
      type: i.type,
      name: i.name || null,
      id: i.id || null,
      placeholder: i.placeholder || null,
      visible: i.offsetParent !== null,
      className: i.className ? i.className.split(' ')[0] : null
    }));
  });
}

// ── Routes ─────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'eBatPro Price API', version: '1.2.0' });
});

// 🔍 DEBUG - Inspecte la page de login sans credentials (appeler dans le navigateur)
app.get('/debug-login', async (req, res) => {
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    page.setDefaultTimeout(25000);
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await page.goto('https://www.ebatpro.fr/login', { waitUntil: 'networkidle2', timeout: 20000 });

    // Attendre un peu que React hydrate
    await new Promise(r => setTimeout(r, 2000));

    const inputs = await getFormInputs(page);
    const pageUrl = page.url();
    const title = await page.title();

    // Cherche les forms
    const forms = await page.evaluate(() => {
      return [...document.querySelectorAll('form')].map(f => ({
        action: f.action || null,
        method: f.method || null,
        id: f.id || null,
        inputs_count: f.querySelectorAll('input').length,
        buttons: [...f.querySelectorAll('button')].map(b => ({ type: b.type, text: b.textContent.trim().slice(0,50) }))
      }));
    });

    // Screenshot en base64
    const screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });

    res.json({
      url: pageUrl,
      title,
      forms,
      inputs,
      screenshot_preview: `data:image/png;base64,${screenshot.slice(0, 200)}... [tronqué]`,
      screenshot_length: screenshot.length,
      info: 'Copie et partage le champ "inputs" pour diagnostiquer le login'
    });
  } catch (error) {
    res.status(500).json({ error: error.message, stack: error.stack?.split('\n').slice(0,5) });
  } finally {
    await browser?.close();
  }
});

// 🔍 DEBUG LOGIN - Teste le login avec credentials et retourne le détail
app.post('/debug-auth', async (req, res) => {
  const { username, password, api_key } = req.body;
  if (api_key !== API_KEY) return res.status(401).json({ error: 'Clé API invalide' });
  if (!username || !password) return res.status(400).json({ error: 'username et password requis' });

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    console.log('[DEBUG-AUTH] Navigation vers /login...');
    await page.goto('https://www.ebatpro.fr/login', { waitUntil: 'networkidle2', timeout: 25000 });
    await new Promise(r => setTimeout(r, 2000));

    const inputsAvant = await getFormInputs(page);
    console.log('[DEBUG-AUTH] Inputs trouvés:', JSON.stringify(inputsAvant));

    // Tentative de remplissage - essai 1: email
    let methode = 'non tentée';
    try {
      const emailInput = inputsAvant.find(i => i.type === 'email' || i.name === 'email' || i.id === 'email' || i.placeholder?.toLowerCase().includes('email'));
      const pwdInput = inputsAvant.find(i => i.type === 'password');

      if (emailInput) {
        const emailSel = emailInput.name ? `input[name="${emailInput.name}"]` : emailInput.id ? `input#${emailInput.id}` : 'input[type="email"]';
        await fillField(page, emailSel, username);
        methode = `fillField sur ${emailSel}`;
        console.log('[DEBUG-AUTH] Email rempli avec', emailSel);
      } else {
        // Fallback: premier input visible non-password
        const firstVisible = inputsAvant.find(i => i.visible && !['password','hidden','submit','button','checkbox','radio'].includes(i.type));
        if (firstVisible) {
          const sel = firstVisible.name ? `input[name="${firstVisible.name}"]` : firstVisible.id ? `input#${firstVisible.id}` : `input[type="${firstVisible.type}"]`;
          await fillField(page, sel, username);
          methode = `fillField (fallback) sur ${sel}`;
        }
      }

      if (pwdInput) {
        await fillField(page, 'input[type="password"]', password);
        console.log('[DEBUG-AUTH] Password rempli');
      }

      // Screenshot avant soumission
      const screenshotAvant = await page.screenshot({ encoding: 'base64' });

      // Soumission
      const navigationPromise = page.waitForNavigation({ timeout: 15000, waitUntil: 'domcontentloaded' }).catch(() => null);
      await page.click('button[type="submit"]');
      await navigationPromise;
      await new Promise(r => setTimeout(r, 2000));

      const urlApres = page.url();
      const title = await page.title();
      const screenshotApres = await page.screenshot({ encoding: 'base64' });

      // Vérifier si connecté
      const connecte = !urlApres.includes('/login');

      res.json({
        connecte,
        url_apres_login: urlApres,
        title_apres_login: title,
        methode_utilisee: methode,
        inputs_trouves: inputsAvant,
        screenshot_avant_soumission_size: screenshotAvant.length,
        screenshot_apres_soumission_size: screenshotApres.length,
      });
    } catch (err) {
      const screenshot = await page.screenshot({ encoding: 'base64' }).catch(() => null);
      res.json({
        connecte: false,
        erreur_remplissage: err.message,
        inputs_trouves: inputsAvant,
        methode_utilisee: methode,
        url_courante: page.url(),
        screenshot_size: screenshot?.length || 0
      });
    }
  } catch (error) {
    console.error('[DEBUG-AUTH ERROR]', error.message);
    res.status(500).json({ error: error.message });
  } finally {
    await browser?.close();
  }
});

// ── Recherche principale ───────────────────────────────────────────────────────

app.post('/recherche', async (req, res) => {
  const { terme, username, password, api_key } = req.body;

  if (api_key !== API_KEY) return res.status(401).json({ error: 'Clé API invalide' });
  if (!terme || !username || !password) return res.status(400).json({ error: 'Paramètres manquants: terme, username, password, api_key' });

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // ── Login ────────────────────────────────────────────────────────────────
    console.log(`[LOGIN] ${username.split('@')[0]}... terme="${terme}"`);
    await page.goto('https://www.ebatpro.fr/login', { waitUntil: 'networkidle2', timeout: 25000 });
    await new Promise(r => setTimeout(r, 2000)); // attendre hydratation React

    const inputs = await getFormInputs(page);
    console.log(`[LOGIN] Inputs: ${JSON.stringify(inputs.filter(i => i.visible))}`);

    // Trouver le champ email/identifiant
    const emailInput = inputs.find(i =>
      i.type === 'email' ||
      i.name === 'email' || i.name === 'username' || i.name === 'login' || i.name === 'identifier' ||
      i.id === 'email' || i.id === 'username' || i.id === 'login' ||
      (i.placeholder && (i.placeholder.toLowerCase().includes('email') || i.placeholder.toLowerCase().includes('identifiant')))
    );
    const pwdInput = inputs.find(i => i.type === 'password');

    let emailSel;
    if (emailInput) {
      emailSel = emailInput.name ? `input[name="${emailInput.name}"]`
                : emailInput.id ? `input#${emailInput.id}`
                : `input[type="${emailInput.type}"]`;
    } else {
      // Fallback: premier input visible
      const first = inputs.find(i => i.visible && !['password','hidden','submit','button','checkbox','radio'].includes(i.type));
      emailSel = first?.name ? `input[name="${first.name}"]`
               : first?.id ? `input#${first.id}`
               : 'input[type="text"]';
    }

    console.log(`[LOGIN] Sélecteur email: ${emailSel}, pwd: ${pwdInput ? 'input[type="password"]' : 'introuvable'}`);

    await fillField(page, emailSel, username);
    if (pwdInput) {
      await fillField(page, 'input[type="password"]', password);
    }

    // Soumettre
    const navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
    await page.click('button[type="submit"]');
    await navPromise;
    await new Promise(r => setTimeout(r, 1500));

    const urlApresLogin = page.url();
    console.log(`[LOGIN] URL après: ${urlApresLogin}`);

    if (urlApresLogin.includes('/login')) {
      await browser.close();
      return res.status(401).json({
        error: 'Login eBatPro échoué - vérifier identifiant/mot de passe',
        email_selector: emailSel,
        inputs_trouves: inputs.filter(i => i.visible)
      });
    }

    // ── Recherche ─────────────────────────────────────────────────────────────
    console.log(`[SEARCH] "${terme}"`);
    await page.goto(`https://www.ebatpro.fr/search?term=${encodeURIComponent(terme)}`, { waitUntil: 'domcontentloaded' });

    try {
      await page.waitForSelector('[class*="ProductCard"][class*="__ProductCard"]', { timeout: 12000 });
    } catch {
      await browser.close();
      return res.json({ terme_recherche: terme, nb_resultats: 0, produits: [], message: `Aucun produit trouvé pour "${terme}"`, source: 'eBatPro_live' });
    }

    // ── Extraction ────────────────────────────────────────────────────────────
    const produits = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[class*="ProductCard"][class*="__ProductCard"]')];
      return cards.slice(0, 10).map(card => {
        const designation = card.querySelector('[class*="text-heading"], h2, h3, [class*="heading"]')?.textContent?.trim() || '';
        const refs = [...card.querySelectorAll('[class*="text-annotation"], [class*="annotation"]')].map(el => el.textContent.trim());
        const code = refs.find(r => /^[A-Z0-9]{3,}/.test(r)) || refs[0] || '';
        const ref_fabricant = refs.find(r => r !== code) || '';
        let prix_public_ht = null, prix_net_ht = null;
        [...card.querySelectorAll('[class*="text-price"], [class*="price"]')].forEach(el => {
          const val = parseFloat((el.innerText || '').replace(/\s/g, '').replace(',', '.').replace(/[^\d.]/g, '')) || null;
          const label = (el.previousElementSibling?.textContent || el.closest('[class*="price"]')?.previousElementSibling?.textContent || '').toLowerCase();
          if (label.includes('public') || label.includes('catalogue')) prix_public_ht = val;
          else if (label.includes('net') || label.includes('pro')) prix_net_ht = val;
          else if (!prix_public_ht && val) prix_public_ht = val;
        });
        const lien = card.querySelector('a[href*="/product/"]')?.getAttribute('href') || '';
        return { designation, code, ref_fabricant, prix_public_ht, prix_net_ht, lien };
      }).filter(p => p.code || p.designation);
    });

    console.log(`[RESULT] ${produits.length} produits pour "${terme}"`);
    res.json({ terme_recherche: terme, nb_resultats: produits.length, produits, source: 'eBatPro_live' });

  } catch (error) {
    console.error(`[ERROR] ${error.message}`);
    res.status(500).json({ error: error.message, terme_recherche: terme });
  } finally {
    await browser?.close();
  }
});

app.listen(PORT, () => console.log(`✅ eBatPro API v1.2.0 - port ${PORT}`));
