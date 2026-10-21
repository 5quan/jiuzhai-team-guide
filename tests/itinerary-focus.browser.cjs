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
      const panelBox = panel.getBoundingClientRect();
      const names = [...document.querySelectorAll('#schedule-list .place-name, #schedule-list .timeline-ink')];
      const metas = [...document.querySelectorAll('#schedule-list .step-meta')];
      const transports = [...document.querySelectorAll('#schedule-list .schedule-leg, #schedule-list .timeline-self-leg')];
      const ink = document.querySelector('#schedule-list .timeline-ink');
      const opacity = id => getComputedStyle(document.querySelector(`#schematic [data-spot="${id}"]`)).opacity;
      return {
        panelBackground: getComputedStyle(panel).backgroundColor,
        panelWidth: panelBox.width,
        panelHeight: panelBox.height,
        timesVisible: metas.length > 0 && metas.every(meta => !meta.hidden && meta.getBoundingClientRect().height > 0),
        transportVisible: transports.length > 0 && transports.every(node => node.getBoundingClientRect().height > 0),
        backing: getComputedStyle(ink, '::before').backgroundColor,
        backingInset: getComputedStyle(ink, '::before').inset,
        currentOpacity: opacity('forest'),
        otherPeriodOpacity: opacity('rhino'),
        otherDayOpacity: opacity('changhai'),
        compact: panel.classList.contains('is-compact'),
        fullLogPresent: Boolean(document.querySelector('.journey-log')),
        mapFootnotePresent: [...document.querySelectorAll('#route > .map-footnote')].some(el => !el.hidden && el.textContent.trim()),
        detailCardPresent: Boolean(document.querySelector('#map-detail'))
      };
    });
    assert.ok(collapsed.panelBackground === 'rgba(0, 0, 0, 0)', 'the itinerary uses text backing, not a full panel wash');
    assert.ok(collapsed.panelWidth <= 184.5);
    assert.equal(collapsed.timesVisible, true, 'place times should always be visible');
    assert.equal(collapsed.transportVisible, true, 'transport durations must stay visible');
    assert.equal(collapsed.backing, 'rgba(255, 252, 245, 0.82)', 'each text line keeps a light paper backing');
    assert.ok(Number(collapsed.currentOpacity) >= .9, 'the reading period stays clear');
    assert.ok(Number(collapsed.otherPeriodOpacity) < .5, 'the same day other period fades');
    assert.ok(Number(collapsed.otherDayOpacity) < .5, 'the other day fades');
    assert.equal(collapsed.fullLogPresent, false, 'the arrival/accommodation log is removed');
    assert.equal(collapsed.mapFootnotePresent, false, 'the map explanation is removed');
    assert.equal(collapsed.detailCardPresent, true);

    await page.locator('[data-step="d1-wuhua"]').click();
    await page.waitForTimeout(120);
    const opened = await page.evaluate(() => {
      const panel = document.querySelector('#inscription').getBoundingClientRect();
      const detail = document.querySelector('#detail-d1-wuhua');
      const card = document.querySelector('#map-detail');
      return {
        expanded: document.querySelector('[data-step="d1-wuhua"]').getAttribute('aria-expanded'),
        detailVisible: !detail.hidden,
        detailInCard: card.contains(detail),
        cardVisible: !card.hidden,
        panelWidth: panel.width,
        panelHeight: panel.height
      };
    });
    assert.equal(opened.expanded, 'true');
    assert.equal(opened.detailVisible, true);
    assert.equal(opened.detailInCard, true, 'details stay in the separate detail card');
    assert.equal(opened.cardVisible, true);
    assert.ok(Math.abs(opened.panelWidth - collapsed.panelWidth) <= .5, 'opening details must not widen the itinerary');
    assert.ok(Math.abs(opened.panelHeight - collapsed.panelHeight) <= .5, 'opening details must not move the itinerary list');

    await page.locator('[data-step="d1-wuhua"]').click();
    await page.waitForTimeout(120);
    const closed = await page.evaluate(() => ({
      expanded: document.querySelector('[data-step="d1-wuhua"]').getAttribute('aria-expanded'),
      cardVisible: !document.querySelector('#map-detail').hidden,
      detailVisible: !document.querySelector('#detail-d1-wuhua').hidden
    }));
    assert.deepEqual(closed, { expanded: 'false', cardVisible: false, detailVisible: false });

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
      assert.ok(layout.panelWidth <= (width <= 700 ? 184 : 192) + .5, `${width} panel width: ${layout.panelWidth}`);
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
