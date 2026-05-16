// ==UserScript==
// @name         Bilibili 稍后再看排序 Toggle
// @namespace    http://tampermonkey.net/
// @version      2026.5.16
// @description  把 https://www.bilibili.com/watchlater/list 的“最近添加 / 最早添加”下拉菜单改成一键 toggle
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
    return t.startsWith('最早') ? EARLIEST : RECENT;
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

  // 视觉:隐下拉箭头 + toggle 标识 + 把弹层彻底盖掉(panel-item 仍在 DOM 里可被合成 click)
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
  `;
  document.head.appendChild(style);

})();
