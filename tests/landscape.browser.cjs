const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  let server;
  let origin = process.env.TEST_ORIGIN;
  if (!origin) {
    const { createServer } = await import('../server.mjs');
    server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  }
  const output = process.env.TEST_OUTPUT || 'docs';
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome', args: ['--no-proxy-server'] });
  const errors = [], checks = [], layouts = [], selectionChecks = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', error => errors.push(error.message));
    const requests = [];
    page.on('request', request => requests.push(request.url()));
    await page.goto(origin);
    await page.waitForSelector('#schematic .route-svg');
    const guide = await page.evaluate(() => fetch('/api/guide').then(response => response.json()));
    assert.equal(await page.locator('#schematic .spot-node').count(), 37);
    assert.equal(await page.locator('#schematic [data-water]').count(), 15);
    assert.ok(requests.every(url => url.startsWith(origin)));
    assert.equal(await page.locator('[data-period="all"]').count(), 0);
    assert.ok(!/参考图|依据两天休闲版/.test(await page.locator('#inscription').innerText()));
    assert.equal(await page.locator('header.header').count(),0);
    assert.equal(await page.locator('#share-button').count(),1);
    assert.equal(await page.locator('#print-button').count(),1);
    await page.evaluate(()=>{navigator.clipboard.writeText=async value=>{window.testCopiedGuide=value;};});
    await page.locator('#share-button').click();
    assert.equal(await page.evaluate(()=>window.testCopiedGuide),origin+'/');
    checks.push('37个点位与15组水面保留；全天按钮和参考图小字已移除');
    for (const width of [320,390,430,768,1280,1440]) {
      await page.setViewportSize({ width, height: 950 });
      const layout = await page.evaluate(() => {
        const stage = document.querySelector('.landscape').getBoundingClientRect();
        const map = document.querySelector('#schematic').getBoundingClientRect();
        const panel = document.querySelector('#inscription').getBoundingClientRect();
        const list=document.querySelector('#schedule-list');
        const input=document.querySelector('#entry-time').getBoundingClientRect();
        const exit=document.querySelector('#exit-time').getBoundingClientRect();
        const timesBelow=[...list.querySelectorAll('.schedule-step')].every(row=>row.querySelector('time').getBoundingClientRect().top>=row.querySelector('strong').getBoundingClientRect().bottom);
        return { width: innerWidth, page: document.documentElement.scrollWidth, mapTop:stage.top+scrollY, panelWidth:panel.width, panelRatio:panel.width/map.width, timesBelow, contentFits:list.scrollWidth<=list.clientWidth+1 && input.right<=panel.right && exit.right<=panel.right, stageHeight: stage.height, mapRatio: map.width / stage.width, overlap: panel.left >= map.left && panel.right <= map.right && panel.top >= map.top && panel.bottom <= map.bottom + 1 };
      });
      assert.equal(layout.page, width); assert.ok(layout.mapRatio > .99 && layout.overlap); assert.ok(layout.mapTop<=100 && layout.stageHeight <= 720); assert.ok(layout.contentFits && layout.timesBelow); assert.ok(width<=700 ? layout.panelRatio<=.5 && layout.panelWidth<=180 : layout.panelWidth<=210); layouts.push(layout);
    }
    checks.push('320—1440px六档宽度无溢出；桌面行程210px、手机最多180px且不超过半屏，时间和时长固定在名称下方');
    checks.push('重复品牌栏已移除，分享与打印合并到小标题行；六档屏宽的地图起点不超过100px，复制链接正常');
    for (const testWidth of [1280,390]) {
      await page.setViewportSize({ width: testWidth, height: testWidth === 390 ? 844 : 1000 });
      for (const day of guide.days.filter(day => day.startTime)) {
        await page.locator(`.day-switch [data-day="${day.id}"]`).click();
        const [hours, mins] = day.startTime.split(':').map(Number);
        let time = hours * 60 + mins;
        const steps = day.events.filter(event => event.duration).map(event => {
          const period = event.mode === 'rest' ? 'noon' : time < 720 ? 'morning' : time < 840 ? 'noon' : 'afternoon';
          time += event.duration;
          return {...event,period};
        });
        for (const period of ['morning','noon','afternoon']) {
          await page.locator(`[data-period="${period}"]`).click();
          const ids = steps.filter(step => step.period === period).map(step => step.id);
          assert.deepEqual(await page.locator('[data-step]').evaluateAll(nodes=>nodes.map(node=>node.dataset.step)), ids);
          for (const id of ids) {
            const zoomBefore = await page.locator('#schematic').getAttribute('data-zoom');
            await page.locator(`[data-step="${id}"]`).click();
            assert.equal(await page.locator(`[data-step="${id}"]`).getAttribute('aria-expanded'), 'true');
            assert.equal(await page.locator('#schematic').getAttribute('data-zoom'), zoomBefore, 'Selecting an itinerary must not enlarge the map');
            const focused = await page.evaluate(() => {
              const marker = document.querySelector('#schematic .selected .route-dot').getBoundingClientRect();
              const frame = document.querySelector('#schematic').getBoundingClientRect();
              const panel = document.querySelector('#inscription').getBoundingClientRect();
              const cx = marker.left + marker.width / 2, cy = marker.top + marker.height / 2;
              return { visible: cx >= frame.left && cx <= frame.right && cy >= frame.top && cy <= frame.bottom, covered: cx >= panel.left && cx <= panel.right && cy >= panel.top && cy <= panel.bottom };
            });
            assert.ok(focused.visible && !focused.covered, `${testWidth}/${id} marker is hidden or covered`);
            assert.equal(await page.locator('#map-ripple .location-ripple').count(), 3);
            assert.equal(await page.locator('#location-pointer').isVisible(),true);
            const pointerAligned=await page.evaluate(()=>{
              const pointer=document.querySelector('#location-pointer'),box=pointer.getBoundingClientRect(),marker=document.querySelector('#schematic .selected .route-dot').getBoundingClientRect();
              const x=marker.left+marker.width/2,y=marker.top+marker.height/2;
              const tip=pointer.classList.contains('points-up')?box.top:box.bottom;
              return Math.abs(box.left+box.width/2-x)<1 && Math.abs(Math.abs(tip-y)-11)<2;
            });
            assert.ok(pointerAligned,`${id} arrow must point at the selected marker`);
            assert.equal(await page.locator('.step-detail:visible').count(), 1);
            selectionChecks.push(`${testWidth}/${id}`);
          }
        }
      }
    }
    checks.push('桌面与手机逐一点选两天36段行程：详情单项展开、定位避开浮层、三道水纹、缩放不变');
    await page.locator('.day-switch [data-day="day1"]').click();
    await page.locator('[data-step="d1-wuhua"]').click();
    assert.match(await page.locator('#detail-d1-wuhua').innerText(), /吃一根烤肠/);
    assert.ok(await page.locator('#detail-d1-wuhua .spot-notes p').evaluate(node=>{
      const text=node.getBoundingClientRect(),list=document.querySelector('#schedule-list').getBoundingClientRect();
      return text.top>=list.top && text.bottom<=list.bottom;
    }), 'The supplied food reminder should be visible when opening Wuhua Lake');
    assert.equal(await page.locator('#detail-d1-wuhua .note-empty').count(), 1);
    await page.locator('#detail-d1-wuhua [data-spot="wuhua-boardwalk"]').click();
    assert.equal(await page.locator('#detail-d1-wuhua .note-empty').count(), 2);
    assert.ok(!(await page.locator('#detail-d1-wuhua').innerText()).includes('吃一根烤肠'));
    await page.locator('#detail-d1-wuhua [data-spot="wuhuahai"]').click();
    assert.match(await page.locator('#detail-d1-wuhua').innerText(), /吃一根烤肠/);
    await page.locator('[data-step="d1-wuhua"]').click();
    assert.equal(await page.locator('#detail-d1-wuhua').isVisible(), false);
    await page.locator('[data-step="d1-wuhua"]').click();
    assert.equal(await page.locator('#detail-d1-wuhua').isVisible(), true);
    await page.waitForTimeout(1900);
    assert.equal(await page.locator('#map-ripple .location-ripple').count(),0);
    assert.equal(await page.locator('#location-pointer').isVisible(),true,'The guidance arrow remains after the water ripple finishes');
    await page.locator('.landscape').evaluate(node=>node.scrollIntoView({block:'start'}));
    const frame = await page.locator('#schematic').boundingBox();
    const beforeDrag = await page.locator('#schematic .route-svg').evaluate(node=>node.style.transform);
    await page.mouse.move(frame.x+frame.width*.82,frame.y+frame.height*.4);
    await page.mouse.down();
    await page.mouse.move(frame.x+frame.width*.82+45,frame.y+frame.height*.4-25,{steps:6});
    await page.mouse.up();
    assert.notEqual(await page.locator('#schematic .route-svg').evaluate(node=>node.style.transform),beforeDrag);
    assert.ok(await page.locator('#inscription').evaluate(node=>node.classList.contains('is-compact')));
    assert.ok(await page.locator('#inscription').evaluate(node=>node.getBoundingClientRect().width<=154 && node.getBoundingClientRect().width<=innerWidth*.44));
    assert.equal(await page.locator('#inscription-settings').isVisible(),false);
    assert.equal(await page.locator('.inscription-heading').isVisible(),false);
    assert.equal(await page.locator('.step-detail:visible').count(),0);
    assert.equal(await page.locator('#schedule-list').isVisible(),true);
    await page.locator('[data-step="d1-wuhua"]').click();
    assert.equal(await page.locator('#inscription-settings').isVisible(),true);
    assert.equal(await page.locator('#detail-d1-wuhua').isVisible(),true);
    checks.push('五花海仅填烤肠提醒；其他看点、注意事项留空；拖图收敛为纯日程列表，再点条目恢复详情');
    for (let i=0;i<8;i++) {
      const button=page.locator('[data-zoom="in"]'); if(await button.isEnabled()) await button.click();
    }
    assert.equal(Number(await page.locator('#schematic').getAttribute('data-zoom')),2);
    assert.equal(await page.locator('[data-zoom="in"]').isEnabled(),false);
    await page.locator('#schematic').focus();
    for(let i=0;i<8;i++) await page.keyboard.press('-');
    assert.equal(Number(await page.locator('#schematic').getAttribute('data-zoom')),1);
    assert.equal(await page.locator('[data-zoom="out"]').isEnabled(),false);
    const fitBefore=await page.locator('#schematic .route-svg').evaluate(node=>node.style.transform);
    await page.keyboard.press('ArrowLeft');
    assert.notEqual(await page.locator('#schematic .route-svg').evaluate(node=>node.style.transform),fitBefore,'The full map also allows bounded movement');
    for(let i=0;i<3;i++) await page.keyboard.press('+');
    const keyBefore=await page.locator('#schematic .route-svg').evaluate(node=>node.style.transform);
    await page.keyboard.press('ArrowRight');
    if(await page.locator('#schematic .route-svg').evaluate(node=>node.style.transform)===keyBefore) await page.keyboard.press('ArrowLeft');
    assert.notEqual(await page.locator('#schematic .route-svg').evaluate(node=>node.style.transform),keyBefore);
    await page.locator('#map-extent').click();
    assert.equal(Number(await page.locator('#schematic').getAttribute('data-zoom')),1);
    const movementBounds=[];
    for(const width of [320,390,430]) {
      await page.setViewportSize({width,height:844});
      for(const zoom of [1,1.6,2]) {
        for(const direction of [[1,1],[1,-1],[-1,1],[-1,-1]]) {
          const result=await page.evaluate(({zoom,direction})=>{
            setMapZoom(zoom);positionMap(direction[0]*100000,direction[1]*100000);
            const frame=document.querySelector('#schematic').getBoundingClientRect(),map=document.querySelector('#schematic .route-svg').getBoundingClientRect();
            const home=mapHomePose(),left=map.left-frame.left,top=map.top-frame.top;
            const halfRange=Math.abs(left-home.left)<=map.width/2+1 && Math.abs(top-home.top)<=map.height/2+1;
            const overlapX=Math.min(map.right,frame.right)-Math.max(map.left,frame.left),overlapY=Math.min(map.bottom,frame.bottom)-Math.max(map.top,frame.top);
            const visibleArea=overlapX>=Math.min(map.width,frame.width)/2-1 && overlapY>=Math.min(map.height,frame.height)/2-1;
            const visible=[...document.querySelectorAll('#schematic .route-dot')].filter(node=>{const b=node.getBoundingClientRect(),x=b.left+b.width/2,y=b.top+b.height/2;return x>=frame.left&&x<=frame.right&&y>=frame.top&&y<=frame.bottom;}).length;
            const lakeVisible=[...document.querySelectorAll('#schematic .lake-shape')].some(node=>{const b=node.getBoundingClientRect();return b.right>frame.left&&b.left<frame.right&&b.bottom>frame.top&&b.top<frame.bottom;});
            return {width:innerWidth,zoom,direction,visible,lakeVisible,inside:halfRange&&visibleArea};
          },{zoom,direction});
          assert.ok(result.inside && result.visible>0 && result.lakeVisible,JSON.stringify(result));movementBounds.push(result);
        }
      }
    }
    await page.setViewportSize({width:390,height:844});
    checks.push('手机三档宽度、三档比例、四个极限方向均在默认位置半幅范围内，至少保留半幅交叠区域和可见湖泊，避免整图滑走');
    await page.locator('.day-switch [data-day="day2"]').click();
    assert.match(await page.locator('#exit-time').innerText(),/17:17/);
    await page.locator('#entry-time').fill('09:00'); await page.locator('#entry-time').dispatchEvent('change');
    assert.match(await page.locator('#exit-time').innerText(),/16:17/);
    await page.locator('#entry-time').fill('11:00'); await page.locator('#entry-time').dispatchEvent('change');
    assert.equal(await page.locator('#timing-warning').isVisible(),true);
    await page.locator('#entry-time').fill('10:00'); await page.locator('#entry-time').dispatchEvent('change');
    await page.locator('.day-switch [data-day="day1"]').click();
    await page.locator('#map-search summary').click(); await page.locator('#spot-search').fill('长海');
    await page.locator('#spot-results [data-spot="changhai"]').click();
    assert.equal(await page.locator('.day-switch [data-day="day2"]').getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('#map-ripple').getAttribute('data-location'),'changhai');
    await page.locator('#schematic [data-spot="changhai"]').focus(); await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(()=>document.activeElement.dataset.spot),'changhai');
    await page.locator('[data-step="d2-changhai"]').focus(); await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(()=>document.activeElement.dataset.step),'d2-changhai');
    assert.equal(await page.locator('#detail-d2-changhai .note-empty').count(),2);
    await page.locator('#map-search summary').click(); await page.locator('#spot-search').fill('老虎海');
    await page.locator('#spot-results [data-spot="tiger"]').click();
    assert.match(await page.locator('#map-caption').innerText(),/沿线景点/);
    checks.push('按钮与键盘限制1—2倍，方向键移动、全图复原、跨日搜索、焦点保留和预计时间调整通过');
    await page.locator('.bottom-nav [data-nav="notes"]').click();
    assert.match(await page.locator('#notes').innerText(),/黄龙九寨站附近/);
    await page.locator('.bottom-nav [data-nav="weather"]').click(); await page.waitForSelector('#windy-frame');
    await page.locator('.bottom-nav [data-nav="itinerary"]').click(); assert.equal(await page.locator('iframe').count(),0);
    await page.evaluate(()=>window.dispatchEvent(new Event('beforeprint')));
    assert.equal(await page.locator('#print-itinerary li').count(),43);
    await page.emulateMedia({media:'print'});
    assert.ok(await page.locator('#schematic').evaluate(node=>node.scrollWidth<=node.clientWidth+1));
    await page.emulateMedia({media:'screen'});
    checks.push('住宿、天气按需加载与三天43项打印行程保留');
    await page.setViewportSize({width:1440,height:1000});
    await page.locator('.day-switch [data-day="day1"]').click(); await page.locator('#map-extent').click();
    await page.locator('[data-step="d1-wuhua"]').click();
    await page.screenshot({path:path.join(output,'landscape-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844}); await page.reload(); await page.waitForSelector('#schematic .route-svg');
    await page.waitForFunction(()=>Number(document.querySelector('#schematic').dataset.zoom)===1.6);
    const overview=await page.evaluate(()=>{
      const frame=document.querySelector('#schematic').getBoundingClientRect();
      const result={};for(const id of ['changhai','forest','wuhuahai']){const b=document.querySelector(`#schematic [data-spot="${id}"] .route-dot`).getBoundingClientRect();result[id]=(b.left+b.width/2-frame.left)/frame.width;}
      return result;
    });
    assert.ok(overview.changhai>.05&&overview.changhai<.2&&overview.forest>.75&&overview.forest<.95&&Math.abs(overview.wuhuahai-.71)<.02);
    checks.push('手机初始1.6倍概览匹配参考构图，两支沟同时可见；点击箭头始终指向选中点，并在水纹结束后保留');
    await page.screenshot({path:path.join(output,'landscape-mobile-full.png'),fullPage:true});
    await page.locator('[data-step="d1-wuhua"]').click();
    await page.locator('.landscape').screenshot({path:path.join(output,'landscape-mobile.png')});
    await page.locator('[data-zoom="in"]').click();
    await page.locator('.landscape').screenshot({path:path.join(output,'landscape-compact-mobile.png')});
    const touchContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    const touchPage=await touchContext.newPage(); touchPage.on('pageerror',error=>errors.push(error.message));
    await touchPage.goto(origin); await touchPage.waitForSelector('#schematic .route-svg');
    await touchPage.locator('.landscape').evaluate(node=>node.scrollIntoView({block:'start'}));
    await touchPage.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const cdp=await touchContext.newCDPSession(touchPage);
    const bounds=await touchPage.locator('#schematic').boundingBox();
    const x=bounds.x+bounds.width*.65,y=bounds.y+170;
    const scrollY=await touchPage.evaluate(()=>window.scrollY);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:x-18,y,id:1},{x:x+18,y,id:2}]});
    for(const distance of [25,35,48,65]) { await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-distance,y,id:1},{x:x+distance,y,id:2}]}); await touchPage.waitForTimeout(30); }
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    const pinchZoom=Number(await touchPage.locator('#schematic').getAttribute('data-zoom')); assert.equal(pinchZoom,2);
    assert.ok(await touchPage.locator('#inscription').evaluate(node=>node.classList.contains('is-compact')));
    const panBefore=await touchPage.locator('#schematic .route-svg').evaluate(node=>node.style.transform);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});
    for(const distance of [10,20,40,60]) { await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+distance,y:y-distance,id:1}]}); await touchPage.waitForTimeout(30); }
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    assert.notEqual(await touchPage.locator('#schematic .route-svg').evaluate(node=>node.style.transform),panBefore);
    assert.equal(await touchPage.evaluate(()=>window.scrollY),scrollY);
    // Let Chromium finish its gesture sequence before starting a separate tap.
    await touchPage.waitForTimeout(350);
    await touchPage.locator('[data-step="d1-wuhua"]').tap();
    await touchPage.waitForFunction(()=>document.querySelector('[data-step="d1-wuhua"]').getAttribute('aria-expanded')==='true',null,{timeout:3000});
    assert.equal(await touchPage.locator('#detail-d1-wuhua').isVisible(),true);
    await touchPage.locator('#map-extent').tap();
    await touchPage.locator('.landscape').evaluate(node=>node.scrollIntoView({block:'start'}));
    await touchPage.locator('#schematic [data-spot="changhai"] .route-dot').tap();
    await touchPage.waitForFunction(()=>document.querySelector('.day-switch [data-day="day2"]').getAttribute('aria-pressed')==='true',null,{timeout:3000});
    assert.equal(await touchPage.locator('.day-switch [data-day="day2"]').getAttribute('aria-pressed'),'true');
    await touchPage.emulateMedia({reducedMotion:'reduce'});
    await touchPage.locator('[data-step="d2-changhai"]').tap();
    assert.equal(await touchPage.locator('.location-ripple').first().evaluate(node=>getComputedStyle(node).animationName),'none');
    await touchContext.close();
    checks.push('手机触控仿真：双指上限2倍、单指移动、自动简览、点按恢复详情、跨日点图及减少动态效果通过');
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(output,'landscape-verification.json'),JSON.stringify({checkedAt:new Date().toISOString(),checks,layouts,selectionChecks,movementBounds,gestures:{pinchZoom,pageScrollUnchanged:true},errors},null,2)+'\n');
    console.log(JSON.stringify({checks,selectionCount:selectionChecks.length,errors}));
  } finally { await browser.close(); if(server) await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);process.exitCode=1;});
