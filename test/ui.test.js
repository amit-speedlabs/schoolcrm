'use strict';
// Browser smoke test of the real UI (skipped when Playwright is not installed).
const test = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const h = require('./helpers');

let chromium;
try { chromium = require('playwright').chromium; } catch {
  try { chromium = require(`${execSync('npm root -g').toString().trim()}/playwright`).chromium; } catch { chromium = null; }
}

test('UI: login, dashboard filters, drill-down, search, profile', { skip: !chromium && 'playwright not installed' }, async () => {
  await h.resetDb();
  await h.createLogin('ui@test.in', 'UiPass1234', 'MANAGEMENT');
  h.writeSheet('ui', 'Master', [
    ['School Name', 'City', 'State', 'School Kit Drop Date', 'No of Kits', 'Channel', 'Sales SPOC'],
    ['Alpha School', 'Pune', 'Maharashtra', '01/09/2026', '2', 'CoE', 'Amit'],
    ['Beta School', 'Surat', 'Gujarat', '', '', 'Direct', 'Priya'],
    ['Gamma School', 'Nagpur', 'Maharashtra', '02/09/2026', '1', 'Direct', 'Amit'],
  ]);
  const src = await h.addSource({ source_name: 'Master', spreadsheet_id: 'ui', sheet_name: 'Master', source_type: 'SCHOOL_MASTER', one_kit_per_school: false });
  await require('../src/sync/syncEngine').syncSource(src.source_id, { triggeredBy: 'test' });
  const { server, base } = await h.startServer();
  const browser = await chromium.launch();
  const errors = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base);
    await page.fill('input[name=email]', 'ui@test.in');
    await page.fill('input[name=password]', 'UiPass1234');
    await page.click('button[type=submit]');
    const kpi = async (label) => page.locator('.kpi', { hasText: label }).first().locator('.value').innerText();
    await page.waitForSelector('.kpi');
    assert.equal(await kpi('TOTAL SCHOOLS'), '3');
    assert.equal(await kpi('KIT DISTRIBUTED'), '2');
    await page.selectOption('#filters select[name=state]', 'Maharashtra');
    await page.waitForFunction(() => location.hash.includes('state=Maharashtra'));
    await page.waitForTimeout(300);
    assert.equal(await kpi('TOTAL SCHOOLS'), '2');
    await page.selectOption('#filters select[name=kit]', 'no');
    await page.waitForTimeout(400);
    assert.equal(await kpi('TOTAL SCHOOLS'), '0');
    // drill-down from the dashboard state table
    await page.goto(`${base}/#/dashboard`);
    await page.locator('tr[data-go="Gujarat"]').click();
    await page.waitForSelector('.crumbs');
    assert.match(await page.locator('.crumbs').innerText(), /Gujarat/);
    await page.locator('tr[data-key="Surat"]').click();
    await page.waitForTimeout(300);
    await page.locator('tr[data-key="Surat"]').click();
    await page.waitForSelector('tr[data-school]');
    await page.locator('tr[data-school]').first().click();
    await page.waitForSelector('h1:has-text("Beta School")');
    assert.match(await page.locator('.panel', { hasText: 'Kit information' }).innerText(), /Kit Given\s+NO/);
    // search
    await page.goto(`${base}/#/schools`);
    await page.fill('#filters input[name=q]', 'gamma');
    await page.waitForFunction(() => location.hash.includes('q=gamma'));
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.table-wrap tbody tr').count(), 1);
    // Student Enrolment lists only schools with students unless "Show all schools" is ticked
    await page.goto(`${base}/#/enrolment`);
    await page.waitForSelector('#showAll');
    assert.match(await page.locator('.table-wrap tbody').innerText(), /No schools match/);
    await page.check('#showAll');
    await page.waitForFunction(() => location.hash.includes('all=1'));
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.table-wrap tbody tr').count(), 3);
    // management sees no admin actions
    assert.equal(await page.locator('#addSchool').count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); server.close(); await h.db.close();
  }
});
