require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const nodemailer = require('nodemailer');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const CHECK_INTERVAL_MS = 20 * 60 * 1000; // 20 minutes
const STATE_FILE = path.join(__dirname, 'matcha-state.json');
const LOG_FILE = path.join(__dirname, 'matcha-monitor.log');

const { GMAIL_USER, GMAIL_APP_PASSWORD, ALERT_EMAIL } = process.env;

const SITES = [
  {
    key: 'marukyu',
    name: 'Marukyu-Koyamaen',
    url: 'https://www.marukyu-koyamaen.co.jp/english/shop/products/catalog/matcha/principal',
    productSelector: 'li.product',
    nameSelector: '.product-name h4, .product-name, h4',
    linkSelector: 'a.woocommerce-loop-product__link, a',
    // This site sits behind a Cloudflare JS challenge that blocks plain HTTP
    // requests (axios/curl always get a 403 "Just a moment..." page), so it
    // needs a real/headless browser to render.
    renderMode: 'browser',
  },
  {
    key: 'lovematcha',
    name: 'Love Matcha',
    url: 'https://lovematcha.co.nz/shop/',
    productSelector: 'li.product',
    nameSelector: '.wc-block-components-product-name, .woocommerce-loop-product__title, h2, h3',
    linkSelector: 'a',
  },
];

// ---------- logging ----------

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ---------- state ----------

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (err) {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------- email ----------

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
});

async function sendEmail(subject, text, html) {
  await transporter.sendMail({
    from: GMAIL_USER,
    to: ALERT_EMAIL,
    subject,
    text,
    html,
  });
}

async function sendTestEmail() {
  try {
    await sendEmail(
      '✅ Matcha Monitor - Test Email',
      'This is a test email confirming your matcha restock monitor is set up correctly and can send email alerts via Gmail.',
      '<p>This is a test email confirming your matcha restock monitor is set up correctly and can send email alerts via Gmail.</p>'
    );
    log('Test email sent successfully to ' + ALERT_EMAIL);
  } catch (err) {
    log('ERROR sending test email: ' + err.message);
    log('Check GMAIL_USER / GMAIL_APP_PASSWORD in .env (must be a 16-char Gmail App Password, not your normal password).');
  }
}

async function sendFailureAlert(site, consecutiveFailures, lastError) {
  const subject = `⚠️ Matcha Monitor: ${site.name} has failed ${consecutiveFailures} checks in a row`;
  const text = `${site.name} has failed to scrape for ${consecutiveFailures} consecutive checks.\n\nLast error: ${lastError}\n\nThe site's markup or bot-protection may have changed. This alert won't repeat until the site recovers and then fails again.`;
  try {
    await sendEmail(subject, text);
    log(`Failure alert email sent for ${site.name} (${consecutiveFailures} consecutive failures)`);
  } catch (err) {
    log(`ERROR sending failure alert for ${site.name}: ${err.message}`);
  }
}

async function sendRestockAlert(site, product) {
  const subject = `🍵 Restock Alert: ${product.name} is back in stock!`;
  const text = `${product.name} just restocked at ${site.name}.\n\nLink: ${product.link}`;
  const html = `
    <p><strong>${product.name}</strong> just restocked at <strong>${site.name}</strong>.</p>
    <p><a href="${product.link}">${product.link}</a></p>
  `;
  try {
    await sendEmail(subject, text, html);
    log(`Restock alert email sent for "${product.name}" (${site.name})`);
  } catch (err) {
    log(`ERROR sending restock alert for "${product.name}": ${err.message}`);
  }
}

// ---------- scraping ----------

function parseProducts(html, site) {
  const $ = cheerio.load(html);
  const products = [];

  $(site.productSelector).each((_, el) => {
    const $el = $(el);
    const name = $el.find(site.nameSelector).first().text().trim();
    let link = $el.find(site.linkSelector).first().attr('href');
    if (link) link = link.trim();

    if (!name || !link) return;

    const classes = ($el.attr('class') || '').split(/\s+/);
    let inStock;
    if (classes.includes('outofstock')) {
      inStock = false;
    } else if (classes.includes('instock')) {
      inStock = true;
    } else {
      inStock = null; // unknown - can't determine from markup
    }

    products.push({ name, link, inStock });
  });

  return products;
}

async function fetchHtmlHttp(site) {
  const response = await axios.get(site.url, {
    timeout: 20000,
    headers: { 'User-Agent': USER_AGENT },
  });
  return response.data;
}

async function fetchHtmlBrowser(site) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.goto(site.url, { waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForSelector(site.productSelector, { timeout: 20000 }).catch(() => {});
    return await page.content();
  } finally {
    await browser.close();
  }
}

async function scrapeSite(site) {
  const html =
    site.renderMode === 'browser' ? await fetchHtmlBrowser(site) : await fetchHtmlHttp(site);
  return parseProducts(html, site);
}

// ---------- core check ----------

async function checkSite(site, state) {
  log(`Checking ${site.name}...`);
  const products = await scrapeSite(site);
  log(`${site.name}: found ${products.length} product(s)`);

  if (!state[site.key]) state[site.key] = {};

  for (const product of products) {
    if (product.inStock === null) {
      log(`WARNING: could not determine stock status for "${product.name}" on ${site.name}`);
    }

    const prev = state[site.key][product.link];

    if (prev && prev.inStock === false && product.inStock === true) {
      log(`RESTOCK DETECTED: "${product.name}" on ${site.name}`);
      await sendRestockAlert(site, product);
    }

    state[site.key][product.link] = {
      name: product.name,
      inStock: product.inStock,
      lastChecked: new Date().toISOString(),
    };
  }
}

const FAILURE_ALERT_THRESHOLD = 5; // consecutive failed checks before emailing an alert

async function checkAllSites() {
  const state = loadState();
  if (!state.__meta) state.__meta = { consecutiveFailures: {} };
  if (!state.__meta.consecutiveFailures) state.__meta.consecutiveFailures = {};

  for (const site of SITES) {
    try {
      await checkSite(site, state);
      state.__meta.consecutiveFailures[site.key] = 0;
    } catch (err) {
      log(`ERROR checking ${site.name}: ${err.message}`);
      const failures = (state.__meta.consecutiveFailures[site.key] || 0) + 1;
      state.__meta.consecutiveFailures[site.key] = failures;
      if (failures === FAILURE_ALERT_THRESHOLD) {
        await sendFailureAlert(site, failures, err.message);
      }
    }
  }

  saveState(state);
  log('Check complete. Next check in 20 minutes.');
}

// ---------- startup ----------

function validateEnv() {
  const missing = ['GMAIL_USER', 'GMAIL_APP_PASSWORD', 'ALERT_EMAIL'].filter((k) => !process.env[k]);
  if (missing.length) {
    log(`ERROR: missing required environment variable(s): ${missing.join(', ')}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}

const RUN_ONCE = process.argv.includes('--once') || process.env.GITHUB_ACTIONS === 'true';

async function main() {
  log('Matcha restock monitor starting...');
  validateEnv();

  const isFirstRunEver = !fs.existsSync(STATE_FILE);
  if (isFirstRunEver) {
    await sendTestEmail();
  }

  await checkAllSites();

  if (RUN_ONCE) {
    log('Single-run mode (--once / CI) complete. Exiting.');
    return;
  }

  setInterval(checkAllSites, CHECK_INTERVAL_MS);
  log(`Monitor running. Checking every ${CHECK_INTERVAL_MS / 60000} minutes.`);
}

main();
