const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');

(async () => {
  const { createServer } = await import('../server.mjs');
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome', args: ['--no-proxy-server'] });
  const errors = [];
  const checks = [];
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    page.on('pageerror', error => errors.push(error.message));
    const requests = [];
    page.on('request', request => requests.push(request.url()));
    await page.goto(origin);
    await page.waitForSelector('#schematic svg');
    assert.equal(await page.locator('#schematic .spot-node').count(), 37);
    assert.equal(await page.locator('#schematic [data-water]').count(), 15);
    assert.ok(requests.every(url => url.startsWith(origin)));
    checks.push('首页仅请求本站资源；37个点位、15组蓝色水面，地图铺满主画面');
    const layouts = [];
    for (const width of [320,390,430,768,1280,1440]) {
      await page.setViewportSize({ width, height: 950 });
      const layout = await page.evaluate(() => {
        const stage = document.querySelector('.landscape').getBoundingClientRect();
        const map = document.querySelector('#schematic').getBoundingClientRect();
        const panel = document.querySelector('#inscription').getBoundingClientRect();
        return { width: innerWidth, page: document.documentElement.scrollWidth, mapRatio: map.width / stage.width, overlap: panel.left >= map.left && panel.right <= map.right && panel.top >= map.top && panel.bottom <= map.bottom + 1 };
      });
      assert.equal(layout.page, width); assert.ok(layout.mapRatio > .99 && layout.overlap); layouts.push(layout);
    }
    checks.push('320—1440px六档宽度无横向溢出，行程浮层位于整幅地图内部');
    await page.setViewportSize({ width: 1280, height: 1000 });
    const selectionChecks = [];
    for (const testWidth of [1280,390]) {
      await page.setViewportSize({ width: testWidth, height: testWidth === 390 ? 844 : 1000 });
    for (const day of ['day1','day2']) {
      await page.locator(`[data-day="${day}"]`).click();
      await page.locator('[data-period="all"]').click();
      const steps = await page.locator('[data-step]').evaluateAll(nodes => nodes.map(node => node.dataset.step));
      assert.equal(steps.length, day === 'day1' ? 19 : 17);
      for (const id of steps) {
        await page.locator(`[data-step="${id}"]`).click();
        assert.equal(await page.locator(`[data-step="${id}"]`).getAttribute('aria-pressed'), 'true');
        const focused = await page.evaluate(() => {
          const marker = document.querySelector('#schematic .selected .route-dot').getBoundingClientRect();
          const frame = document.querySelector('#schematic').getBoundingClientRect();
          const panel = document.querySelector('#inscription').getBoundingClientRect();
          const cx = marker.left + marker.width / 2, cy = marker.top + marker.height / 2;
          return { visible: cx >= frame.left && cx <= frame.right && cy >= frame.top && cy <= frame.bottom, covered: cx >= panel.left && cx <= panel.right && cy >= panel.top && cy <= panel.bottom };
        });
        assert.ok(focused.visible && !focused.covered, `${id} marker is hidden or covered`);
        selectionChecks.push(`${testWidth}/${id}`);
        if (await page.locator('[data-period="all"]').getAttribute('aria-pressed') !== 'true') await page.locator('[data-period="all"]').click();
      }
    }
    }
    checks.push('36个逐段行程在手机和桌面逐一点击，日期、时间与地点联动，定位点避开行程浮层');
    await page.locator('[data-day="day2"]').click();
    assert.ok((await page.locator('#exit-time').innerText()).includes('17:17'));
    await page.locator('#entry-time').fill('09:00'); await page.locator('#entry-time').dispatchEvent('change');
    assert.ok((await page.locator('#exit-time').innerText()).includes('16:17'));
    await page.locator('#entry-time').fill('11:00'); await page.locator('#entry-time').dispatchEvent('change');
    assert.equal(await page.locator('#timing-warning').isVisible(), true);
    await page.locator('#entry-time').fill('10:00'); await page.locator('#entry-time').dispatchEvent('change');
    await page.locator('[data-day="day1"]').click();
    await page.locator('#map-search summary').click(); await page.locator('#spot-search').fill('长海');
    await page.locator('#spot-results [data-spot="changhai"]').click();
    assert.equal(await page.locator('[data-day="day2"]').getAttribute('aria-pressed'), 'true');
    assert.ok((await page.locator('#map-caption h3').innerText()).includes('长海'));
    assert.ok((await page.locator('#schedule-list .selected').innerText()).includes('长海'));
    await page.locator('#map-search summary').click(); await page.locator('#spot-search').fill('老虎海');
    await page.locator('#spot-results [data-spot="tiger"]').click();
    assert.ok((await page.locator('#map-caption').innerText()).includes('沿线景点'));
    checks.push('入园时间调整正确累计；超参考闭园时间提醒；搜索跨日地点切换到对应日期，沿线可选点不套用错误时段');
    await page.locator('[data-day="day1"]').click();
    await page.locator('[data-period="all"]').click();
    await page.locator('[data-step="d1-wuhua"]').focus(); await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.step), 'd1-wuhua');
    await page.locator('#schematic [data-spot="wuhuahai"]').focus(); await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.spot), 'wuhuahai');
    await page.locator('[data-toggle-panel]').click(); assert.equal(await page.locator('#inscription-body').isVisible(), false);
    await page.locator('[data-toggle-panel]').click(); assert.equal(await page.locator('#inscription-body').isVisible(), true);
    await page.locator('#map-extent').click(); assert.equal(await page.locator('#schematic').getAttribute('data-zoom'), '1');
    await page.locator('[data-zoom="in"]').click(); assert.ok(Number(await page.locator('#schematic').getAttribute('data-zoom')) > 1);
    await page.locator('[data-day="day1"]').click(); await page.locator('#map-extent').click();
    await page.locator('#schematic [data-spot="changhai"] .route-dot').click();
    assert.equal(await page.locator('[data-day="day2"]').getAttribute('aria-pressed'),'true');
    checks.push('行程收展、全图复原、缩放按钮、鼠标点图和键盘选点通过，焦点保留');
    await page.locator('.bottom-nav [data-nav="notes"]').click();
    const notes = await page.locator('#notes').innerText();
    assert.ok(notes.includes('黄龙九寨站附近') && notes.includes('17:17') && !/重庆|06:35|周二/.test(notes));
    await page.locator('.bottom-nav [data-nav="weather"]').click();
    await page.waitForSelector('#windy-frame');
    assert.ok((await page.locator('#windy-frame').getAttribute('src')).startsWith('https://embed.windy.com/'));
    await page.locator('.bottom-nav [data-nav="itinerary"]').click();
    assert.equal(await page.locator('iframe').count(), 0);
    checks.push('住宿、待定返程和注意事项保留；天气按需挂载并在离开后卸载');
    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    assert.equal(await page.locator('#print-itinerary li').count(), 43);
    await page.emulateMedia({ media: 'print' });
    const print = await page.locator('#schematic').evaluate(node => ({ width: node.clientWidth, scrollWidth: node.scrollWidth }));
    assert.ok(print.scrollWidth <= print.width + 1);
    await page.emulateMedia({ media: 'screen' });
    checks.push('打印包含三天43项完整行程，地图全幅显示');
    const labelAudit = await page.evaluate(() => {
      const outside = [];
      for (const node of [...document.querySelectorAll('#schematic .spot-node')]) {
        chooseSpot(node.dataset.spot);
        const text = node.querySelector('.spot-label'); const box = text.getBBox();
        if (box.x < 0 || box.y < 0 || box.x + box.width > 1600 || box.y + box.height > 1150) outside.push(node.dataset.spot);
      }
      return outside;
    });
    assert.deepEqual(labelAudit, []);
    await page.locator('[data-day="day1"]').click(); await page.locator('#map-extent').click();
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.screenshot({ path: 'docs/landscape-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); await page.reload(); await page.waitForSelector('#schematic svg');
    await page.locator('.landscape').screenshot({ path: 'docs/landscape-mobile.png' });
    await page.locator('[data-day="day2"]').click(); await page.locator('[data-period="all"]').click();
    await page.locator('[data-step="d2-inner"]').click();
    await page.locator('.landscape').screenshot({ path: 'docs/landscape-day2-mobile.png' });
    const touchContext = await browser.newContext({ viewport: { width:390, height:844 }, isMobile:true, hasTouch:true });
    const touchPage = await touchContext.newPage(); touchPage.on('pageerror', error => errors.push(error.message));
    await touchPage.goto(origin); await touchPage.waitForSelector('#schematic svg');
    await touchPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await touchPage.locator('#schematic').scrollIntoViewIfNeeded();
    await touchPage.evaluate(() => setMapZoom(2));
    const cdp = await touchContext.newCDPSession(touchPage);
    const bounds = await touchPage.locator('#schematic').boundingBox();
    const x = bounds.x + bounds.width / 2, y = bounds.y + 120;
    const scrollY = await touchPage.evaluate(() => window.scrollY);
    await cdp.send('Input.dispatchTouchEvent', { type:'touchStart', touchPoints:[{x:x-18,y,id:1},{x:x+18,y,id:2}] });
    for (const distance of [24,31,40,48]) { await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-distance,y,id:1},{x:x+distance,y,id:2}]}); await touchPage.waitForTimeout(30); }
    await cdp.send('Input.dispatchTouchEvent', {type:'touchEnd', touchPoints:[]});
    const pinchZoom = Number(await touchPage.locator('#schematic').getAttribute('data-zoom')); assert.ok(pinchZoom>2);
    await touchPage.evaluate(() => { setMapZoom(5); document.querySelector('#schematic').scrollTo(0,0); });
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:x+20,y:y+25,id:1}]});
    for (const distance of [10,20,40,60]) { await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+20-distance,y:y+25-distance,id:1}]}); await touchPage.waitForTimeout(30); }
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    const pan = await touchPage.locator('#schematic').evaluate(node=>({left:node.scrollLeft,top:node.scrollTop})); assert.ok(pan.left>0 && pan.top>0);
    assert.equal(await touchPage.evaluate(() => window.scrollY), scrollY);
    await touchPage.locator('#map-extent').tap();
    await touchPage.locator('.landscape').evaluate(node => node.scrollIntoView({block:'start'}));
    await touchPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await touchPage.locator('#schematic [data-spot="changhai"] .route-dot').tap();
    await touchPage.waitForFunction(() => document.querySelector('[data-day="day2"]').getAttribute('aria-pressed') === 'true', null, {timeout:3000});
    assert.equal(await touchPage.locator('[data-day="day2"]').getAttribute('aria-pressed'),'true');
    const gestures = {pinchZoom,pan,pageScrollUnchanged:true,tapSwitchesDay:true};
    checks.push('移动设备触控仿真：双指连续缩放、单指横纵拖动、点按跨日景点通过，未带动页面滚动');
    await touchContext.close();
    assert.equal(errors.length, 0);
    fs.writeFileSync('docs/landscape-verification.json', JSON.stringify({ checkedAt: new Date().toISOString(), checks, layouts, selectionChecks, labelAudit, gestures, errors }, null, 2) + '\n');
    console.log(JSON.stringify({ checks, layouts, errors }));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
