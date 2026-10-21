// 开屏动画：图片加载完成后停 2.2 秒淡出；同一次会话只播一次。
// 样式在 style.css 的 .splash 里（CSP 不允许内联样式与内联脚本）。
(function () {
  const splash = document.getElementById('splash');
  if (!splash) return;
  const image = splash.querySelector('img');
  if (!image) { splash.remove(); return; }

  try {
    if (sessionStorage.getItem('splash-seen') === '1') { splash.remove(); return; }
  } catch { /* 隐私模式下 sessionStorage 可能不可用，照常播放 */ }

  const HOLD = 2500;
  let closed = false;
  let timer = 0;

  const finish = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    try { sessionStorage.setItem('splash-seen', '1'); } catch { /* 忽略 */ }
    splash.classList.add('hide');
    setTimeout(() => splash.remove(), 500);
  };

  const start = () => {
    clearTimeout(timer);
    timer = setTimeout(finish, HOLD);
  };

  splash.addEventListener('click', finish);
  window.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === 'Escape') finish();
  });

  if (image.complete && image.naturalWidth) start();
  else {
    image.addEventListener('load', start, { once: true });
    // 图片缺失时不要让开屏挡住页面。
    image.addEventListener('error', finish, { once: true });
  }
})();
