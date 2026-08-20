// ==UserScript==
// @name         Bilibili 稍后再看排序 Toggle
// @namespace    http://tampermonkey.net/
// @version      2026.8.20.1
// @description  主按钮显示当前排序，悬浮菜单提供另外两项，点击主按钮时反转顺序
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

  const SORT_LABELS = {
    added: '添加时间',
    views: '播放量',
    duration: '时长',
  };
  const DIRECTION_LABELS = {
    added: { asc: '旧到新', desc: '新到旧' },
    views: { asc: '少到多', desc: '多到少' },
    duration: { asc: '短到长', desc: '长到短' },
  };

  let activeSortMetric = null;
  let activeSortDirection = null;
  const sortMenuItems = new Map();
  let menuObserver = null;

  function activeSortParam() {
    if (activeSortMetric === 'added') return ['wl_added', activeSortDirection];
    if (activeSortMetric === 'duration') return ['wl_dur', activeSortDirection];
    if (activeSortMetric === 'views') return ['wl_views', activeSortDirection];
    return null;
  }

  function applySortParam(url, sortParam) {
    url.searchParams.delete('wl_added');
    url.searchParams.delete('wl_dur');
    url.searchParams.delete('wl_views');
    if (sortParam) url.searchParams.set(sortParam[0], sortParam[1]);
  }

  // 自定义排序状态下点"播放全部":拦掉原生跳转,改成跳到播放器并把排序写进 URL。
  // 列表 DOM 已经重排过,第一个 card 就是要先播的视频,用它的封面链接做起点。
  document.addEventListener('click', (e) => {
    const sortParam = activeSortParam();
    if (!activeSortMetric) return;
    const btn = e.target.closest && e.target.closest('button.action-btn');
    if (!btn || !/播放全部/.test(btn.textContent || '')) return;
    const first = document.querySelector(`${LIST_SELECTOR} ${CARD_SELECTOR} a.bili-cover-card`);
    const href = first ? first.getAttribute('href') : '';
    if (!href) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    const u = new URL(href.startsWith('//') ? location.protocol + href : href, location.origin);
    applySortParam(u, sortParam);
    location.href = u.toString();
  }, true);

  // 自定义排序状态下直接点某个视频跳转:给它的播放链接带上排序参数,
  // 这样播放页使用相同顺序,而起播的仍是点击的那个视频(URL 里的 bvid 不变)。
  // 封面链接通常 target=_blank,所以这里只改写 href、不拦截默认行为。
  document.addEventListener('click', (e) => {
    const sortParam = activeSortParam();
    if (!activeSortMetric) return;
    const a = e.target.closest && e.target.closest('a[href*="watchlater"]');
    if (!a) return;
    const raw = a.getAttribute('href') || '';
    if (!/[?&]bvid=/.test(raw)) return; // 只处理指向具体视频的播放链接
    const u = new URL(raw.startsWith('//') ? location.protocol + raw : raw, location.origin);
    applySortParam(u, sortParam);
    a.setAttribute('href', u.toString());
  }, true);

  // ---- 自定义排序 ----
  // 稍后再看列表由 Vue 渲染,但直接重排 section 下的 card DOM 节点能稳定保留
  // (Vue 不会把我们的顺序刷回去)。选择时长或播放量排序时:
  // 持续滚到底把所有视频懒加载出来(直到出现"已经探索到底了～"),重排后滚回顶部。
  // 添加时间复用原生菜单项,由 Vue 自己请求 history/toview API,不会触发滚动加载。

  const LIST_SELECTOR = 'section.watchlater-list-container';
  const CARD_SELECTOR = '.video-card';
  const API_URL =
    'https://api.bilibili.com/x/v2/medialist/toview/web' +
    '?out_referer=&mobi_app=web&ps=1000&desc=false&sort_field=1&web_location=333.1245';

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
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

  function sortCards(list, getValue, descending) {
    list.sort((a, b) => {
      const da = getValue(a);
      const db = getValue(b);
      // 指标缺失的卡片统一排到末尾,不让 null 干扰顺序
      if (da === null && db === null) return 0;
      if (da === null) return 1;
      if (db === null) return -1;
      return descending ? db - da : da - db;
    });
  }

  function cardBvid(card) {
    const link = card.querySelector('a[href*="bvid="]');
    const match = link && (link.getAttribute('href') || '').match(/[?&]bvid=([^&#]+)/);
    return match ? match[1] : null;
  }

  async function loadApiItems() {
    try {
      const response = await fetch(API_URL, { credentials: 'include' });
      const json = await response.json();
      const list = json && json.data && json.data.list;
      if (!Array.isArray(list)) {
        console.error(`[${new Date().toISOString()}] [wl-sort] invalid toview response`, {
          result: 'kept original order',
        });
        return null;
      }
      return list;
    } catch (error) {
      console.error(`[${new Date().toISOString()}] [wl-sort] fetch toview list failed`, {
        error,
        result: 'kept original order',
      });
      return null;
    }
  }

  async function sortByApiValue(getValue, descending) {
    const sec = document.querySelector(LIST_SELECTOR);
    if (!sec) return false;
    const [, apiItems] = await Promise.all([loadAll(), loadApiItems()]);
    if (!apiItems) return false;
    const values = new Map(apiItems.map((item) => [item.bvid, getValue(item)]));
    const list = cards();
    sortCards(list, (card) => {
      const value = values.get(cardBvid(card));
      return typeof value === 'number' ? value : null;
    }, descending);
    list.forEach((card) => sec.appendChild(card));
    const el = document.scrollingElement || document.documentElement;
    el.scrollTo({ top: 0, behavior: 'smooth' });
    return true;
  }

  async function materializeNativeMenu() {
    const button = document.querySelector('button.order-btn');
    if (!button) return null;
    button.dispatchEvent(new MouseEvent('mouseenter', { view: window }));

    for (let i = 0; i < 40; i++) {
      const items = Array.from(document.querySelectorAll('.menu-popover__panel-item'))
        .filter((item) => !item.classList.contains('wl-sort-menu-item'));
      const recent = items.find((item) => (item.textContent || '').trim() === '最近添加');
      const earliest = items.find((item) => (item.textContent || '').trim() === '最早添加');
      if (recent && earliest) return { recent, earliest };
      await sleep(25);
    }

    console.error(`[${new Date().toISOString()}] [wl-sort] native order menu timeout`, {
      timeoutMs: 1000,
      result: 'kept current order',
    });
    return null;
  }

  async function sortByAddedTime(descending) {
    const nativeItems = await materializeNativeMenu();
    if (!nativeItems) return false;
    const targetLabel = descending ? '最近添加' : '最早添加';
    const target = descending ? nativeItems.recent : nativeItems.earliest;
    target.click();
    await sleep(0);
    return true;
  }

  function sortByViews(descending) {
    return sortByApiValue(
      (item) => item.arc_info && item.arc_info.stat && item.arc_info.stat.view,
      descending,
    );
  }

  function sortByDuration(descending) {
    return sortByApiValue(
      (item) => item.arc_info && item.arc_info.duration,
      descending,
    );
  }

  let sorting = false;
  function updateSortMenu() {
    const button = document.querySelector('button.order-btn');
    if (button && activeSortMetric) {
      setButtonLabel(SORT_LABELS[activeSortMetric]);
      button.title = `${SORT_LABELS[activeSortMetric]}：${DIRECTION_LABELS[activeSortMetric][activeSortDirection]}`;
      button.setAttribute('aria-label', button.title);
    }
    for (const [metric, item] of sortMenuItems) {
      const active = metric === activeSortMetric;
      item.hidden = active;
      item.setAttribute('aria-checked', String(active));
      item.title = `${SORT_LABELS[metric]}：${DIRECTION_LABELS[metric][active ? activeSortDirection : 'asc']}`;
    }
  }

  function setSortingBusy(busy) {
    const button = document.querySelector('button.order-btn');
    if (button) button.setAttribute('aria-busy', String(busy));
    for (const item of sortMenuItems.values()) item.setAttribute('aria-disabled', String(busy));
  }

  function onSortClick(sortMetric) {
    if (sorting) return;
    const direction = activeSortMetric === sortMetric && activeSortDirection === 'asc' ? 'desc' : 'asc';
    const descending = direction === 'desc';
    const previousMetric = activeSortMetric;
    const previousDirection = activeSortDirection;
    activeSortMetric = sortMetric;
    activeSortDirection = direction;
    sorting = true;
    updateSortMenu();
    setSortingBusy(true);
    const sort = sortMetric === 'added'
      ? sortByAddedTime
      : sortMetric === 'views' ? sortByViews : sortByDuration;
    sort(descending).then((sorted) => {
      if (sorted) {
        updateSortMenu();
        return;
      }
      activeSortMetric = previousMetric;
      activeSortDirection = previousDirection;
      updateSortMenu();
    }).catch((error) => {
      activeSortMetric = previousMetric;
      activeSortDirection = previousDirection;
      updateSortMenu();
      console.error(`[${new Date().toISOString()}] [wl-sort] sort failed`, {
        error,
        sortMetric,
        result: 'kept original order',
      });
    }).finally(() => {
      sorting = false;
      setSortingBusy(false);
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

  function installCurrentButtonHandler() {
    const button = document.querySelector('button.order-btn');
    if (!button) return false;
    if (button.dataset.wlSortClickInstalled === 'true') return true;
    button.dataset.wlSortClickInstalled = 'true';
    button.addEventListener('click', (event) => {
      if (!activeSortMetric) return;
      event.stopImmediatePropagation();
      event.stopPropagation();
      event.preventDefault();
      onSortClick(activeSortMetric);
      button.dispatchEvent(new MouseEvent('mouseleave', { view: window }));
    }, true);
    return true;
  }

  function installSortMenu() {
    const panel = document.querySelector('.menu-popover__panel');
    if (!panel) return false;
    const nativeItems = Array.from(panel.querySelectorAll(':scope > .menu-popover__panel-item'))
      .filter((item) => !item.classList.contains('wl-sort-menu-item'));
    const template = nativeItems[0];
    if (!template) return false;

    nativeItems.forEach((item) => {
      item.hidden = true;
      item.classList.add('wl-native-order-item');
    });

    if (!panel.querySelector('.wl-sort-menu-item')) {
      sortMenuItems.clear();
      for (const metric of ['added', 'views', 'duration']) {
        const item = template.cloneNode(false);
        item.hidden = false;
        item.classList.remove('wl-native-order-item');
        item.classList.add('wl-sort-menu-item');
        item.dataset.sortMetric = metric;
        item.setAttribute('role', 'menuitemradio');
        item.textContent = SORT_LABELS[metric];
        item.addEventListener('click', (event) => {
          event.stopImmediatePropagation();
          event.stopPropagation();
          event.preventDefault();
          onSortClick(metric);
          document.querySelector('button.order-btn')
            ?.dispatchEvent(new MouseEvent('mouseleave', { view: window }));
        });
        panel.appendChild(item);
        sortMenuItems.set(metric, item);
      }
    } else {
      sortMenuItems.clear();
      panel.querySelectorAll('.wl-sort-menu-item').forEach((item) => {
        sortMenuItems.set(item.dataset.sortMetric, item);
      });
    }
    updateSortMenu();
    return true;
  }

  function buildSortMenu() {
    if (menuObserver) return true;
    const popover = document.querySelector('button.order-btn')?.closest('.menu-popover');
    if (!popover || !document.querySelector(LIST_SELECTOR)) return false;

    installCurrentButtonHandler();
    menuObserver = new MutationObserver(() => {
      installCurrentButtonHandler();
      installSortMenu();
    });
    menuObserver.observe(popover, { childList: true, subtree: true });
    activeSortMetric = 'added';
    activeSortDirection = 'desc';
    updateSortMenu();
    return true;
  }

  // 排序按钮可能在脚本运行后才挂载,轮询直到拿到为止
  (function waitForButton() {
    let tries = 0;
    const timer = setInterval(() => {
      if (buildSortMenu() || ++tries > 40) clearInterval(timer);
    }, 250);
  })();

})();
