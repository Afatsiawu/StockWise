/* Dev-only browser smoke check. Run with: node tools/ui-check.cjs
   Requires Playwright: npm i -D playwright && npx playwright install chromium */
const { chromium } = (() => {
  try {
    return require('playwright');
  } catch {
    return require('/tmp/pw/node_modules/playwright');
  }
})();
const path = require('node:path');
const fs = require('node:fs');

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const OUT = path.join(process.cwd(), 'artifacts');
fs.mkdirSync(OUT, { recursive: true });

const pages = [
  { hash: '#/dashboard', name: 'dashboard', expect: 'Dashboard' },
  { hash: '#/products', name: 'products', expect: 'Products' },
  { hash: '#/products/5', name: 'product-detail', expect: 'PulseBuds' },
  { hash: '#/sales', name: 'sales', expect: 'New sale' },
  { hash: '#/analytics', name: 'analytics', expect: 'Pareto analysis' },
  { hash: '#/reorder', name: 'reorder', expect: 'Purchase plan' },
  { hash: '#/suppliers', name: 'suppliers', expect: 'SoundWave' },
];

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const problems = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) =>
    problems.push(`requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText}`),
  );

  let failures = 0;
  for (const entry of pages) {
    await page.goto(`${BASE}/${entry.hash}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
    const body = await page.innerText('#view');
    const ok = body.includes(entry.expect) && body.length > 200;
    if (!ok) {
      failures += 1;
      problems.push(`view ${entry.name}: expected text "${entry.expect}" (got ${body.length} chars)`);
    }
    await page.screenshot({ path: path.join(OUT, `${entry.name}.png`), fullPage: true });
    console.log(`${entry.name}: ${ok ? 'ok' : 'FAIL'} (${body.length} chars)`);
  }

  // Interaction check: open the reorder policy modal and a product's stock modal.
  await page.goto(`${BASE}/#/reorder`, { waitUntil: 'networkidle' });
  await page.click('#policy-settings');
  await page.waitForTimeout(200);
  const modalVisible = await page.isVisible('.modal');
  if (!modalVisible) {
    failures += 1;
    problems.push('policy settings modal did not open');
  } else {
    await page.screenshot({ path: path.join(OUT, 'policy-modal.png') });
    await page.keyboard.press('Escape');
  }

  await page.goto(`${BASE}/#/products/16`, { waitUntil: 'networkidle' });
  await page.click('#receive-stock');
  await page.waitForTimeout(200);
  const stockModal = await page.isVisible('#stock-form');
  if (!stockModal) {
    failures += 1;
    problems.push('receive stock modal did not open');
  }
  await page.keyboard.press('Escape');

  // Console errors are not fatal for missing-favicon style noise, but must be reported.
  console.log(`\nproblems (${problems.length}):`);
  for (const problem of problems) console.log(' -', problem);
  console.log(`failures: ${failures}`);

  await browser.close();
  process.exitCode = failures > 0 ? 1 : 0;
})();
