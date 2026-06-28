// ==UserScript==
// @name         Bilibili 稍后再看排序 Toggle
// @namespace    http://tampermonkey.net/
// @version      2026.6.28.1
// @description  把 https://www.bilibili.com/watchlater/list 的“最近添加 / 最早添加”下拉菜单改成一键 toggle，并新增按时长排序
// @author       taozhuang
// @match        https://www.bilibili.com/watchlater/list*
// @match        https://www.bilibili.com/watchlater*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  if (window._biliWatchlaterToggleRunning) return;
  window._biliWatchlaterToggleRunning = true;

  const RECENT = '最近添加';
  const EARLIEST = '最早添加';
  const LONGEST = '从长到短';
  const SHORTEST = '从短到长';

  // 按钮文字会被我们改成时长排序的标签,但 toggle 仍需要知道 Vue 真正的排序方向,
  // 所以用 realOrderLabel 记住最近一次真实的"最近/最早"状态。
  let realOrderLabel = RECENT;

  // 思路:
  // 1) Vue 把 panel-item 在第一次"开菜单"之前是不渲染的 — 我们在脚本加载后,
  //    用合成事件给按钮发一次 pointerdown/up,把 Vue 的 menu 摸到 isOpen=true,
  //    让它把 panel-item 渲染到 DOM 里。(合成 PointerEvent 在新鲜的页面能正常
  //    触发 Vue 的 toggle handler;只有在 Vue 内部状态被弄乱后才会失效。)
  // 2) panel-item 一直留在 DOM,我们用 CSS 让 vui_popover 永远不可见。
  // 3) 给按钮挂 capture 阶段的 pointerdown/click 拦截,阻止 Vue 自己开关菜单 ——
  //    这样 Vue 的 isOpen 永远停在 step-1 设的"true",不会跟我们打架。
  // 4) 拦到点击后,看当前按钮文字,合成点对应的"另一个"panel-item — Vue 的
  //    order 状态被切换、按钮文字随之更新、列表自动 refetch。

  let synthetic = false;
  function fire(el, type, EvtCtor, opts = {}) {
    synthetic = true;
    el.dispatchEvent(new EvtCtor(type, { bubbles: true, cancelable: true, view: window, ...opts }));
    synthetic = false;
  }

  function buttonLabel(btn) {
    const t = (btn.textContent || '').trim();
    if (t === LONGEST || t === SHORTEST) return realOrderLabel;
    realOrderLabel = t.startsWith('最早') ? EARLIEST : RECENT;
    return realOrderLabel;
  }

  function findItem(label) {
    const items = document.querySelectorAll('.menu-popover__panel-item');
    return Array.from(items).find((i) => (i.textContent || '').trim() === label);
  }

  function clickItem(item) {
    fire(item, 'pointerdown', PointerEvent);
    fire(item, 'pointerup', PointerEvent);
    fire(item, 'click', MouseEvent);
  }

  function materializeItems() {
    const btn = document.querySelector('button.order-btn');
    if (!btn) return false;
    if (document.querySelector('.menu-popover__panel-item')) return true;
    fire(btn, 'pointerdown', PointerEvent);
    fire(btn, 'pointerup', PointerEvent);
    return !!document.querySelector('.menu-popover__panel-item');
  }

  function intercept(e) {
    if (synthetic) return;
    const btn = e.target.closest && e.target.closest('button.order-btn');
    if (!btn) return;

    const itemsExist = !!document.querySelector('.menu-popover__panel-item');
    if (itemsExist) {
      // 已经有 panel-item — 拦掉 Vue 的开关菜单逻辑,我们自己直接合成点 item
      e.stopImmediatePropagation();
      e.stopPropagation();
      e.preventDefault();
    }
    // 否则放行让 Vue 打开菜单(CSS 已经把弹层盖掉,用户看不到),
    // panel-item 渲染出来后我们再合成点对应那一项

    const target = buttonLabel(btn) === RECENT ? EARLIEST : RECENT;
    let tries = 0;
    const tryClick = () => {
      const item = findItem(target);
      if (item) {
        clickItem(item);
        return;
      }
      if (++tries < 20) setTimeout(tryClick, 25);
    };
    tryClick();
  }

  // 只挂 pointerdown — Vue 的 menu 是 pointerdown 触发,先于 click 处理我们就够了。
  // 同时挂 click 会让一次用户点击触发两次 toggle,反而抵消。
  document.addEventListener('pointerdown', intercept, true);

  // ---- 按时长排序:鼠标悬浮排序按钮时额外弹出菜单 ----
  // 稍后再看列表由 Vue 渲染,但直接重排 section 下的 card DOM 节点能稳定保留
  // (Vue 不会把我们的顺序刷回去)。点"从长到短/从短到长"时:
  // 持续滚到底把所有视频懒加载出来(直到出现"已经探索到底了～"),再按时长重排,最后滚回顶部。

  const LIST_SELECTOR = 'section.watchlater-list-container';
  const CARD_SELECTOR = '.video-card';

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // 时长文字形如 "MM:SS" 或 "HH:MM:SS"。看过的视频会显示 "已看进度/总时长"(如 "16:52/56:01"),
  // 总时长是最后一个时间戳,所以取所有 stat 里最后一个符合时间格式的 token。
  function durationSeconds(card) {
    const text = Array.from(card.querySelectorAll('.bili-cover-card__stat'))
      .map((s) => (s.textContent || '').trim())
      .join(' ');
    const matches = text.match(/\d{1,3}(?::\d{2})+/g);
    if (!matches || matches.length === 0) return null;
    const last = matches[matches.length - 1];
    return last.split(':').reduce((acc, n) => acc * 60 + parseInt(n, 10), 0);
  }

  function cards() {
    const sec = document.querySelector(LIST_SELECTOR);
    if (!sec) return [];
    return Array.from(sec.querySelectorAll(CARD_SELECTOR));
  }

  // 列表全部加载完后,底部会出现 "已经探索到底了～" 的提示
  function reachedEnd() {
    const empty = document.querySelector('.watchlater-list-empty');
    return !!empty && /探索到底了/.test(empty.textContent || '') && empty.getClientRects().length > 0;
  }

  // 持续滚到底部触发懒加载,直到出现 "已经探索到底了～" 为止
  async function loadAll() {
    const el = document.scrollingElement || document.documentElement;
    for (let i = 0; i < 300 && !reachedEnd(); i++) {
      el.scrollTo(0, el.scrollHeight);
      await sleep(300);
    }
  }

  async function sortByDuration(descending) {
    const sec = document.querySelector(LIST_SELECTOR);
    if (!sec) return;
    await loadAll();
    const list = cards();
    list.sort((a, b) => {
      const da = durationSeconds(a);
      const db = durationSeconds(b);
      // 时长解析不出来的(没有时长的卡片)统一排到末尾,不让 null 干扰顺序
      if (da === null && db === null) return 0;
      if (da === null) return 1;
      if (db === null) return -1;
      return descending ? db - da : da - db;
    });
    list.forEach((c) => sec.appendChild(c));
    const el = document.scrollingElement || document.documentElement;
    el.scrollTo({ top: 0, behavior: 'smooth' });
  }

  let sorting = false;
  function onSortClick(descending, menu) {
    if (sorting) return;
    sorting = true;
    menu.classList.add('wl-dur-menu--busy');
    sortByDuration(descending).finally(() => {
      sorting = false;
      menu.classList.remove('wl-dur-menu--busy');
      // 时长排序后把按钮文字改成对应标签(Vue 不知道这个排序,所以手动改)
      setButtonLabel(descending ? LONGEST : SHORTEST);
    });
  }

  // 按钮第一个文本节点就是排序标签,改它的内容即可,保留后面的下拉箭头 svg
  function setButtonLabel(text) {
    const btn = document.querySelector('button.order-btn');
    if (!btn) return;
    const node = Array.from(btn.childNodes).find((n) => n.nodeType === Node.TEXT_NODE);
    if (node) node.nodeValue = text + ' ';
    else btn.insertBefore(document.createTextNode(text + ' '), btn.firstChild);
  }

  function buildMenu() {
    const popover = document.querySelector('button.order-btn')?.closest('.menu-popover');
    if (!popover || popover.querySelector('.wl-dur-menu')) return !!popover;
    popover.classList.add('wl-dur-anchor');

    const menu = document.createElement('div');
    menu.className = 'wl-dur-menu';

    const longBtn = document.createElement('button');
    longBtn.className = 'wl-dur-item';
    longBtn.textContent = '从长到短';
    longBtn.addEventListener('click', () => onSortClick(true, menu));

    const shortBtn = document.createElement('button');
    shortBtn.className = 'wl-dur-item';
    shortBtn.textContent = '从短到长';
    shortBtn.addEventListener('click', () => onSortClick(false, menu));

    menu.appendChild(longBtn);
    menu.appendChild(shortBtn);
    popover.appendChild(menu);
    return true;
  }

  // 排序按钮可能在脚本运行后才挂载,轮询直到拿到为止
  (function waitForButton() {
    let tries = 0;
    const timer = setInterval(() => {
      if (buildMenu() || ++tries > 40) clearInterval(timer);
    }, 250);
  })();

  // 视觉:隐下拉箭头 + toggle 标识 + 把原生弹层彻底盖掉(panel-item 仍在 DOM 里可被合成 click)
  // 以及自定义的时长排序悬浮菜单
  const style = document.createElement('style');
  style.textContent = `
    button.order-btn .option-icon { display: none !important; }
    button.order-btn { padding-right: 12px !important; }
    button.order-btn::after {
      content: '⇄';
      margin-left: 6px;
      font-size: 12px;
      opacity: 0.6;
    }
    .vui_popover { visibility: hidden !important; pointer-events: none !important; }

    .menu-popover.wl-dur-anchor { position: relative; }
    .wl-dur-menu {
      position: absolute;
      top: 100%;
      right: 0;
      margin-top: 0;
      padding: 4px;
      display: none;
      flex-direction: column;
      min-width: 100px;
      background: var(--bg1_float, #fff);
      border: 1px solid var(--line_regular, #e3e5e7);
      border-radius: 12px;
      box-shadow: 0 8px 40px 0 rgba(0, 0, 0, 0.1);
      z-index: 10000;
    }
    .menu-popover.wl-dur-anchor:hover .wl-dur-menu { display: flex; }
    .wl-dur-item {
      appearance: none;
      border: none;
      background: transparent;
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 13px;
      line-height: 1.4;
      color: var(--text2, #61666d);
      text-align: left;
      cursor: pointer;
      white-space: nowrap;
    }
    .wl-dur-item:hover {
      background: var(--graph_bg_regular, #f1f2f3);
      color: var(--brand_blue, #00aeec);
    }
    .wl-dur-menu--busy { opacity: 0.6; pointer-events: none; }
    .wl-dur-menu--busy .wl-dur-item { cursor: progress; }
  `;
  document.head.appendChild(style);

})();
