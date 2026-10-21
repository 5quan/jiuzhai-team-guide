const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const { createServer } = await import('../server.mjs');
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const output = process.env.TEST_OUTPUT || 'docs';
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome', args: ['--no-proxy-server'] });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => sessionStorage.setItem('splash-seen', '1'));
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#schematic .route-svg');
    await page.locator('.day-switch [data-day="day1"]').click();
    await page.locator('[data-period="morning"]').click();
    await page.waitForTimeout(120);

    const collapsed = await page.evaluate(() => {
      const panel = document.querySelector('#inscription');
      const names = [...document.querySelectorAll('#schedule-list .place-name')];
      const metas = [...document.querySelectorAll('#schedule-list .step-meta')];
      const transports = [...document.querySelectorAll('#schedule-list .schedule-leg, #schedule-list .timeline-self-leg')];
      const opacity = id => getComputedStyle(document.querySelector(`#schematic [data-spot="${id}"]`)).opacity;
      return {
        panelBackground: getComputedStyle(panel).backgroundColor,
        nameBackground: getComputedStyle(names[0]).backgroundColor,
        names: names.length,
        timesCollapsed: metas.length > 0 && metas.every(meta => meta.hidden),
        transportVisible: transports.length > 0 && transports.every(node => node.getBoundingClientRect().height > 0),
        currentOpacity: opacity('forest'),
        otherPeriodOpacity: opacity('rhino'),
        otherDayOpacity: opacity('changhai'),
        compact: panel.classList.contains('is-compact')
      };
    });
    assert.equal(collapsed.names > 0, true);
    assert.equal(collapsed.timesCollapsed, true, 'place times should start collapsed to names only');
    assert.equal(collapsed.transportVisible, true, 'transport durations must stay visible');
    assert.equal(collapsed.compact, true);
    assert.match(collapsed.panelBackground, /^rgba\(250, 246, 237, 0\.\d+\)$/);
    const panelAlpha = Number(collapsed.panelBackground.split(',').at(-1).replace(')', '').trim());
    assert.ok(panelAlpha > .3 && panelAlpha < .9, 'the itinerary needs a light, still see-through paper wash');
    assert.match(collapsed.nameBackground, /^rgba\(255, 250, 238, 0\.\d+\)$/);
    assert.ok(Number(collapsed.currentOpacity) >= .9, 'the reading period stays clear');
    assert.ok(Number(collapsed.otherPeriodOpacity) < .5, 'the same day other period fades');
    assert.ok(Number(collapsed.otherDayOpacity) < .5, 'the other day fades');

    await page.locator('[data-step="d1-wuhua"]').click();
    await page.waitForTimeout(80);
    const opened = await page.evaluate(() => {
      const row = document.querySelector('[data-step-row="d1-wuhua"]');
      return {
        expanded: row.querySelector('[data-step]').getAttribute('aria-expanded'),
        timeVisible: !row.querySelector('.step-meta').hidden,
        detailVisible: !document.querySelector('#map-detail').hidden,
        compact: document.querySelector('#inscription').classList.contains('is-compact')
      };
    });
    assert.deepEqual(opened, { expanded: 'true', timeVisible: true, detailVisible: true, compact: false });
    await page.locator('[data-step="d1-wuhua"]').click();
    await page.waitForTimeout(80);
    const closed = await page.evaluate(() => {
      const row = document.querySelector('[data-step-row="d1-wuhua"]');
      return { expanded: row.querySelector('[data-step]').getAttribute('aria-expanded'), timeHidden: row.querySelector('.step-meta').hidden, compact: document.querySelector('#inscription').classList.contains('is-compact') };
    });
    assert.deepEqual(closed, { expanded: 'false', timeHidden: true, compact: true });

    await page.locator('[data-period="afternoon"]').click();
    await page.waitForTimeout(100);
    const fadedAfternoon = await page.evaluate(() => ({
      currentOpacity: getComputedStyle(document.querySelector('#schematic [data-spot="rhino"]')).opacity,
      morningOpacity: getComputedStyle(document.querySelector('#schematic [data-spot="forest"]')).opacity
    }));
    assert.ok(Number(fadedAfternoon.currentOpacity) >= .9 && Number(fadedAfternoon.morningOpacity) < .5);

    for (const width of [320, 390, 430, 768, 1440]) {
      await page.setViewportSize({ width, height: width <= 700 ? 844 : 1000 });
      await page.waitForTimeout(80);
      const layout = await page.evaluate(() => {
        const panel = document.querySelector('#inscription').getBoundingClientRect();
        const nav = document.querySelector('.bottom-nav').getBoundingClientRect();
        return { left: panel.left, right: panel.right, bottom: panel.bottom, viewport: innerWidth, navTop: nav.top, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, panelWidth: panel.width };
      });
      assert.ok(layout.left >= 0 && layout.right <= layout.viewport + .5 && layout.scrollWidth === layout.clientWidth, `${width} overflow`);
      assert.ok(layout.panelWidth <= (width <= 700 ? 184 : 192) + .5, `${width} panel width`);
      assert.ok(layout.bottom <= layout.navTop + .5, `${width} panel behind bottom nav`);
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.day-switch [data-day="day1"]').click();
    await page.locator('[data-period="morning"]').click();
    await page.waitForTimeout(120);
    await page.screenshot({ path: path.join(output, 'itinerary-focus-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForTimeout(120);
    await page.screenshot({ path: path.join(output, 'itinerary-focus-desktop.png'), fullPage: true });

    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'itinerary-focus-verification.json'), `${JSON.stringify({ checkedAt: new Date().toISOString(), collapsed, opened, closed, fadedAfternoon, errors }, null, 2)}\n`);
    console.log(JSON.stringify({ ok: true, collapsed, opened, closed, fadedAfternoon, errors }));
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
