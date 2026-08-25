// ==UserScript==
// @name         Bilibili 稍后再看播放页时长排序
// @namespace    http://tampermonkey.net/
// @version      2026.8.25.1
// @description  根据 URL 参数对稍后再看播放器的播放列表排序
// @author       taozhuang
// @match        https://www.bilibili.com/list/watchlater*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // 排序方式直接写在 URL 里:wl_added 按添加时间,wl_dur 按时长,
  // wl_views 按播放量,wl_progress 按观看进度。
  // 没有有效参数就完全不介入,保持播放器原本(按添加时间)的顺序。
  const params = new URLSearchParams(location.search);
  const addedDir = params.get('wl_added');
  const durationDir = params.get('wl_dur');
  const viewsDir = params.get('wl_views');
  const progressDir = params.get('wl_progress');
  const sortMetric = progressDir === 'desc' || progressDir === 'asc'
    ? 'progress'
    : viewsDir === 'desc' || viewsDir === 'asc'
      ? 'views'
      : durationDir === 'desc' || durationDir === 'asc'
        ? 'duration'
        : addedDir === 'desc' || addedDir === 'asc' ? 'added' : null;
  if (!sortMetric) return;
  const dir = sortMetric === 'progress'
    ? progressDir
    : sortMetric === 'views' ? viewsDir : sortMetric === 'duration' ? durationDir : addedDir;
  const descending = dir === 'desc';

  function byValue(getValue) {
    return (a, b) => {
      const da = getValue(a);
      const db = getValue(b);
      if (da === null && db === null) return 0;
      if (da === null) return 1;
      if (db === null) return -1;
      return descending ? db - da : da - db;
    };
  }

  // 播放器的队列(window.__INITIAL_STATE__.resourceList)是按"添加时间"分页懒加载的,
  // 而且只在起始视频附近加载一个窗口;起始视频在添加列表里靠后时,滚动也补不全。
  // 所以直接用一次大 ps 的接口请求把整张稍后再看列表拉全,按指定指标排好,
  // 映射成 resourceList 的结构后原地替换整个数组(reactive,队列与自动连播都用新顺序)。
  const API_URL =
    'https://api.bilibili.com/x/v2/medialist/toview/web' +
    '?out_referer=&mobi_app=web&ps=1000&desc=false&sort_field=1&web_location=333.1245';
  const LIST_ITEM_SELECTOR = '.action-list-item-wrap[data-key]';
  const CURRENT_MARKER_SELECTOR = '.singlep-list-item-inner.siglep-active, .multip-list-item-active';
  // A 2026-08-16 Chrome CDP trace showed Bilibili's native smooth scroll settling in about 500ms.
  const SCROLL_SETTLE_MS = 800;

  function arcDuration(item) {
    const d = item && item.arc_info && item.arc_info.duration;
    return typeof d === 'number' ? d : null;
  }

  function arcAddedAt(item) {
    return typeof item.add_at === 'number' ? item.add_at : null;
  }

  function arcViews(item) {
    const views = item && item.arc_info && item.arc_info.stat && item.arc_info.stat.view;
    return typeof views === 'number' ? views : null;
  }

  /**
    * @param {{ progress?: number, arc_info?: { duration?: number } } | null | undefined} item
   * @returns {number | null}
   */
  function arcProgress(item) {
    const progress = item && item.progress;
    const duration = arcDuration(item);
    return typeof progress === 'number' && progress >= 0 && duration > 0
      ? progress / duration
      : null;
  }

  function formatViews(n) {
    if (typeof n !== 'number') return '';
    return n >= 10000 ? (n / 10000).toFixed(1) + '万播放' : n + '播放';
  }

  // 把接口项映射成播放器 resourceList 用的结构(稍后再看里基本都是普通投稿视频 type=2)
  function toResourceItem(apiItem, i, total) {
    const arc = apiItem.arc_info || {};
    const pages = (arc.pages || []).map((p) => ({
      cid: p.cid,
      title: p.part || arc.title,
      duration: p.duration || 0,
      p: p.page || 1,
    }));
    return {
      index: i,
      oid: arc.aid,
      bvid: apiItem.bvid,
      aid: arc.aid,
      cid: apiItem.cid || arc.cid || (pages[0] && pages[0].cid),
      type: 2,
      attr: 0,
      title: arc.title,
      cover: (arc.pic || '').replace(/^https?:/, ''),
      tag: '',
      views: formatViews(arc.stat && arc.stat.view),
      pages,
      isHead: i === 0,
      isTail: i === total - 1,
    };
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function currentResourceList() {
    const s = window.__INITIAL_STATE__;
    return s && Array.isArray(s.resourceList) ? s.resourceList : null;
  }

  /**
   * @param {Element} content
   * @returns {{ active: Element | null, key: string | null }}
   */
  function currentListState(content) {
    const items = Array.from(content.querySelectorAll(LIST_ITEM_SELECTOR));
    const marker = content.querySelector(CURRENT_MARKER_SELECTOR);
    const markedItem = marker && marker.closest(LIST_ITEM_SELECTOR);
    const currentBvid = new URLSearchParams(location.search).get('bvid');
    const active = markedItem || items.find((item) => item.dataset.key === currentBvid) || null;
    return {
      active,
      key: active ? active.dataset.key : null,
    };
  }

  /**
   * @param {Element} content
   * @param {string} phase
   * @param {string} reason
   * @param {string} traceId
   * @returns {void}
   */
  function alignCurrentItem(content, phase, reason, traceId) {
    const { active } = currentListState(content);
    if (!active) {
      console.debug(`[${new Date().toISOString()}] [wl-sort] current item alignment completed`, {
        phase,
        reason,
        result: 'active item unavailable',
        traceId,
      });
      return;
    }
    active.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' });
    console.debug(`[${new Date().toISOString()}] [wl-sort] current item alignment completed`, {
      phase,
      reason,
      result: 'aligned',
      traceId,
    });
  }

  /**
   * @returns {void}
   */
  function installCurrentItemAlignment() {
    if (typeof document.querySelector !== 'function') return;
    const content = document.querySelector('.action-list-content');
    if (!content) {
      console.error(`[${new Date().toISOString()}] [wl-sort] current item observer unavailable`, {
        result: 'playlist content not found',
      });
      return;
    }

    let alignmentGeneration = 0;
    let alignmentSequence = 0;
    let previousState = currentListState(content);

    /**
     * @param {string} reason
     * @returns {void}
     */
    function scheduleAlignment(reason) {
      const generation = ++alignmentGeneration;
      const traceId = `wl-scroll-${Date.now()}-${++alignmentSequence}`;
      console.debug(`[${new Date().toISOString()}] [wl-sort] current item alignment scheduled`, {
        delayMs: SCROLL_SETTLE_MS,
        reason,
        traceId,
      });
      alignCurrentItem(content, 'immediate', reason, traceId);
      setTimeout(() => {
        if (generation !== alignmentGeneration) {
          console.debug(`[${new Date().toISOString()}] [wl-sort] current item alignment completed`, {
            phase: 'settled',
            reason,
            result: 'superseded',
            traceId,
          });
          return;
        }
        alignCurrentItem(content, 'settled', reason, traceId);
      }, SCROLL_SETTLE_MS);
    }

    const observer = new MutationObserver(() => {
      const nextState = currentListState(content);
      if (nextState.key === previousState.key) return;
      previousState = nextState;
      scheduleAlignment('current item changed');
    });
    observer.observe(content, {
      attributeFilter: ['class'],
      attributes: true,
      childList: true,
      subtree: true,
    });
    scheduleAlignment('initial sort');
  }

  async function loadAllAndSort() {
    // 等播放器把初始队列建好(resourceList 挂上且有内容)
    for (let i = 0; i < 60 && !(currentResourceList() && currentResourceList().length); i++) {
      await sleep(250);
    }
    if (!currentResourceList()) return;

    let list;
    try {
      const r = await fetch(API_URL, { credentials: 'include' });
      const j = await r.json();
      list = j && j.data && j.data.list;
    } catch (e) {
      console.error(`[${new Date().toISOString()}] [wl-sort] fetch full toview list failed`, {
        error: e,
        sortMetric,
        result: 'kept original queue',
      });
      return;
    }
    if (!Array.isArray(list) || !list.length) return;

    list = list.filter((x) => x && x.arc_info);
    const getSortValue = sortMetric === 'progress'
      ? arcProgress
      : sortMetric === 'views' ? arcViews : sortMetric === 'duration' ? arcDuration : arcAddedAt;
    list.sort(byValue(getSortValue));
    const total = list.length;
    const items = list.map((it, i) => toResourceItem(it, i, total));

    // 播放器在初始加载阶段会反复把 resourceList 重置回它自己的小窗口,
    // 所以反复原地替换,直到我们的整张列表不再被覆盖为止。
    for (let i = 0; i < 30; i++) {
      const live = currentResourceList();
      if (!live) break;
      const stuck = live.length === items.length && live[0] && live[0].bvid === items[0].bvid;
      if (stuck) {
        if (i > 0) break; // 经过一轮(400ms)没被覆盖,认为已稳定
      } else {
        live.splice(0, live.length, ...items);
      }
      await sleep(400);
    }
    installCurrentItemAlignment();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => loadAllAndSort());
  } else {
    loadAllAndSort();
  }
})();
