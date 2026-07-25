// ==UserScript==
// @name         Bilibili 稍后再看排序 Toggle
// @namespace    http://tampermonkey.net/
// @version      2026.7.25
// @description  把稍后再看排序改成添加时间、播放量、时长三个按钮，重复点击当前按钮时反转顺序
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
  const sortButtons = new Map();

  function intercept(e) {
    const btn = e.target.closest && e.target.closest('button.order-btn');
    if (!btn) return;
    e.stopImmediatePropagation();
    e.stopPropagation();
    e.preventDefault();
    onSortClick('added');
  }

  // 只挂 pointerdown — Vue 的 menu 是 pointerdown 触发,先于 click 处理我们就够了。
  // 同时挂 click 会让一次用户点击触发两次 toggle,反而抵消。
  document.addEventListener('pointerdown', intercept, true);

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

  const LIST_SELECTOR = 'section.watchlater-list-container';
  const CARD_SELECTOR = '.video-card';
  const API_URL =
    'https://api.bilibili.com/x/v2/medialist/toview/web' +
    '?out_referer=&mobi_app=web&ps=1000&desc=false&sort_field=1&web_location=333.1245';

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
    if (!sec) return false;
    await loadAll();
    const list = cards();
    sortCards(list, durationSeconds, descending);
    list.forEach((c) => sec.appendChild(c));
    const el = document.scrollingElement || document.documentElement;
    el.scrollTo({ top: 0, behavior: 'smooth' });
    return true;
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

  function sortByAddedTime(descending) {
    return sortByApiValue((item) => item.add_at, descending);
  }

  function sortByViews(descending) {
    return sortByApiValue(
      (item) => item.arc_info && item.arc_info.stat && item.arc_info.stat.view,
      descending,
    );
  }

  let sorting = false;
  function updateSortButtons() {
    for (const [metric, button] of sortButtons) {
      const active = metric === activeSortMetric;
      button.classList.toggle('wl-sort-active', active);
      button.setAttribute('aria-pressed', String(active));
      button.title = `${SORT_LABELS[metric]}：${DIRECTION_LABELS[metric][active ? activeSortDirection : 'asc']}`;
      if (active) button.dataset.direction = activeSortDirection;
      else delete button.dataset.direction;
    }
  }

  function setSortingBusy(busy) {
    for (const button of sortButtons.values()) {
      button.classList.toggle('wl-sort-busy', busy);
      button.setAttribute('aria-busy', String(busy));
    }
  }

  function onSortClick(sortMetric) {
    if (sorting) return;
    const direction = activeSortMetric === sortMetric && activeSortDirection === 'asc' ? 'desc' : 'asc';
    const descending = direction === 'desc';
    sorting = true;
    setSortingBusy(true);
    const sort = sortMetric === 'added'
      ? sortByAddedTime
      : sortMetric === 'views' ? sortByViews : sortByDuration;
    sort(descending).then((sorted) => {
      if (!sorted) return;
      activeSortMetric = sortMetric;
      activeSortDirection = direction;
      setButtonLabel(SORT_LABELS.added);
      updateSortButtons();
    }).catch((error) => {
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

  function buildSortButtons() {
    if (sortButtons.size) return true;
    const popover = document.querySelector('button.order-btn')?.closest('.menu-popover');
    const addedButton = document.querySelector('button.order-btn');
    if (!popover || !addedButton || !document.querySelector(LIST_SELECTOR)) return false;

    addedButton.classList.add('wl-sort-button');
    addedButton.dataset.sortMetric = 'added';

    const viewsButton = document.createElement('button');
    viewsButton.className = 'wl-sort-button';
    viewsButton.dataset.sortMetric = 'views';
    viewsButton.textContent = SORT_LABELS.views;
    viewsButton.addEventListener('click', () => onSortClick('views'));

    const durationButton = document.createElement('button');
    durationButton.className = 'wl-sort-button';
    durationButton.dataset.sortMetric = 'duration';
    durationButton.textContent = SORT_LABELS.duration;
    durationButton.addEventListener('click', () => onSortClick('duration'));

    popover.after(viewsButton, durationButton);
    sortButtons.set('added', addedButton);
    sortButtons.set('views', viewsButton);
    sortButtons.set('duration', durationButton);
    setButtonLabel(SORT_LABELS.added);
    updateSortButtons();
    onSortClick('added');
    return true;
  }

  // 排序按钮可能在脚本运行后才挂载,轮询直到拿到为止
  (function waitForButton() {
    let tries = 0;
    const timer = setInterval(() => {
      if (buildSortButtons() || ++tries > 40) clearInterval(timer);
    }, 250);
  })();

  // 隐藏原生弹层,三个指标按钮显示当前方向。
  const style = document.createElement('style');
  style.textContent = `
    button.order-btn .option-icon { display: none !important; }
    .vui_popover { visibility: hidden !important; pointer-events: none !important; }
    .wl-sort-button {
      appearance: none;
      border: none;
      background: transparent;
      padding: 6px 10px !important;
      font-size: 14px;
      line-height: 20px;
      color: var(--text2, #61666d);
      cursor: pointer;
      white-space: nowrap;
    }
    .wl-sort-button:hover,
    .wl-sort-button.wl-sort-active {
      color: var(--brand_blue, #00aeec);
    }
    .wl-sort-button[data-direction]::after {
      margin-left: 6px;
      font-size: 12px;
      opacity: 0.8;
    }
    .wl-sort-button[data-direction='asc']::after { content: '↑'; }
    .wl-sort-button[data-direction='desc']::after { content: '↓'; }
    .wl-sort-button.wl-sort-busy { opacity: 0.6; cursor: progress; }
  `;
  document.head.appendChild(style);

})();
