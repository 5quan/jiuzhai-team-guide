const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
(async () => {
  const { createServer } = await import('../server.mjs');
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  const output = process.env.TEST_OUTPUT || 'docs/map-refactor';
  fs.mkdirSync(output, { recursive: true });
  try {
    const page = await browser.newPage();
    const errors = [], layouts = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector('.timeline-stop');
    for (const [width, height] of [[320,568],[375,667],[390,844],[430,932],[768,1024],[1440,1000]]) {
      await page.setViewportSize({ width, height });
      for (const day of ['day1', 'day2']) {
        await page.locator(`[data-day="${day}"]`).click();
        for (const period of ['morning', 'afternoon']) {
          await page.locator(`[data-period="${period}"]`).click();
          const layout = await page.evaluate(() => {
            const list = document.querySelector('#schedule-list'), panel = document.querySelector('#inscription').getBoundingClientRect();
            const nav = document.querySelector('.bottom-nav').getBoundingClientRect();
            const nodes = [...list.querySelectorAll('.timeline-node')].map(n => n.getBoundingClientRect());
            const frame = list.getBoundingClientRect();
            const ink = list.querySelector('.timeline-ink');
            return { count: nodes.length, visible: nodes.filter(n => n.top + 10 >= frame.top && n.top + 10 <= frame.bottom).length, bottom: panel.bottom, limit: nav.top, fits: panel.top >= 0 && panel.bottom <= nav.top && panel.left >= 0 && panel.right <= innerWidth, scroll: list.scrollHeight - list.clientHeight, overflow: document.documentElement.scrollWidth > innerWidth, panelBackground: getComputedStyle(document.querySelector('#inscription')).backgroundColor, textBackground: getComputedStyle(ink,'::before').backgroundColor };
          });
          layouts.push({width,height,day,period,...layout});
          assert.ok(layout.fits && !layout.overflow && layout.visible <= 4 && layout.visible > 0 && (layout.count <= 4 || layout.scroll > 0), JSON.stringify(layouts.at(-1)));
          assert.equal(layout.panelBackground,'rgba(0, 0, 0, 0)');
          assert.equal(layout.textBackground,'rgba(255, 252, 245, 0.82)');
        }
      }
      await page.locator('[data-day="day1"]').click();
      await page.screenshot({ path: `${output}/same-screen-${width}.png` });
    }
    await page.setViewportSize({width:390,height:844});
    await page.locator('[data-step="d1-wuhua"]').click();
    assert.equal(await page.locator('#map-detail #detail-d1-wuhua').isVisible(),true);
    await page.screenshot({path:`${output}/same-screen-detail.png`});
    assert.equal(await page.locator('.terrain-land, .terrain-forest, .terrain-valley').count(),0);
    assert.equal(await page.locator('.mobile-artwork img').isVisible(),true);
    const performanceResult = await page.evaluate(async () => {
      const container = document.querySelector('#schematic');
      const rect = container.getBoundingClientRect();
      const original = SVGTextContentElement.prototype.getComputedTextLength;
      let measurements = 0, writes = 0;
      SVGTextContentElement.prototype.getComputedTextLength = function(...args) { measurements++; return original.apply(this,args); };
      const observer = new MutationObserver(records => { writes += records.filter(r => r.attributeName === 'style').length; });
      observer.observe(container.querySelector('.route-svg'), {attributes:true});
      const fire = (type,x,y) => container.dispatchEvent(new PointerEvent(type,{pointerId:7,pointerType:'touch',clientX:rect.left+x,clientY:rect.top+y,bubbles:true}));
      // Synthetic pointers do not participate in native capture; native touch is covered separately.
      const capture = container.setPointerCapture;
      container.setPointerCapture = () => {};
      const start = container.querySelector('.route-svg').style.transform;
      const frames = [];
      fire('pointerdown',250,300);
      for(let i=0;i<30;i++) {
        const t=performance.now();
        for(let n=0;n<8;n++) fire('pointermove',250+(i*8+n)*.2,300-(i*8+n)*.1);
        await new Promise(requestAnimationFrame);
        frames.push(performance.now()-t);
      }
      const during = measurements, renderWrites = writes;
      fire('pointerup',298,276);
      await new Promise(requestAnimationFrame);
      const result = { events:240, renderWrites, textMeasurementsDuringDrag:during, textMeasurementsAfterRelease:measurements-during, moved:start!==container.querySelector('.route-svg').style.transform, framesMs:frames };
      observer.disconnect(); container.setPointerCapture=capture; SVGTextContentElement.prototype.getComputedTextLength=original;
      return result;
    });
    assert.equal(performanceResult.textMeasurementsDuringDrag,0);
    assert.ok(performanceResult.textMeasurementsAfterRelease > 0);
    assert.ok(performanceResult.renderWrites <= 30 && performanceResult.moved);
    assert.deepEqual(errors,[]);
    fs.writeFileSync(`${output}/same-screen-verification.json`,JSON.stringify({layouts,performanceResult,errors},null,2));
    console.log(JSON.stringify({layouts:layouts.length,performanceResult,errors}));
  } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
