// ==UserScript==
// @name         Bilibili 稍后再看播放页时长排序
// @namespace    http://tampermonkey.net/
// @version      2026.6.28.2
// @description  根据 URL 参数 wl_dur(desc=从长到短 / asc=从短到长)对稍后再看播放器的播放列表按时长排序
// @author       taozhuang
// @match        https://www.bilibili.com/list/watchlater*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // 排序方向直接写在 URL 里:?wl_dur=desc 从长到短,?wl_dur=asc 从短到长。
  // 没有这个参数就完全不介入,保持播放器原本(按添加时间)的顺序。
  const dir = new URLSearchParams(location.search).get('wl_dur');
  if (dir !== 'desc' && dir !== 'asc') return;
  const descending = dir === 'desc';

  function bySeconds(getSeconds) {
    return (a, b) => {
      const da = getSeconds(a);
      const db = getSeconds(b);
      return descending ? db - da : da - db;
    };
  }

  // 接口响应里每个视频都带 arc_info.duration,按 bvid 存下来,
  // 给那些通过"加载更多"补进 resourceList、但本身没带 pages 时长的项兜底。
  const durByBvid = new Map();

  // ---- 主播放列表:服务端把它直接塞进 HTML 的 window.__INITIAL_STATE__.resourceList ----
  // 播放器、右侧播放队列、自动连播都读这个数组,客户端请求改不到它。
  // resourceList 项没有 duration 字段,但每个 pages[].duration 求和就是总时长;
  // 翻页补进来的项可能没有 pages,就用 bvid->duration 兜底。
  function resourceDuration(item) {
    const pages = item && item.pages;
    if (Array.isArray(pages) && pages.length) {
      const sum = pages.reduce((acc, p) => acc + (p.duration || 0), 0);
      if (sum > 0) return sum;
    }
    if (item && durByBvid.has(item.bvid)) return durByBvid.get(item.bvid);
    return -1;
  }

  // 就地把 resourceList 按时长排好并重新编号(同一个数组对象是 Vue 的响应式数据,
  // 原地 sort 会让播放队列实时跟着重排)。
  function sortResourceList(list) {
    if (!Array.isArray(list) || list.length === 0) return;
    list.sort(bySeconds(resourceDuration));
    list.forEach((it, i) => {
      it.index = i;
      it.isHead = i === 0;
      it.isTail = i === list.length - 1;
    });
  }

  function currentResourceList() {
    const s = window.__INITIAL_STATE__;
    return s && Array.isArray(s.resourceList) ? s.resourceList : null;
  }

  // __INITIAL_STATE__ 是页面后面的内联 <script> 赋值的,document-start 时还不存在。
  // 用 setter 拦截赋值,在播放器读取前就地重排 resourceList。
  let stateValue;
  try {
    Object.defineProperty(window, '__INITIAL_STATE__', {
      configurable: true,
      enumerable: true,
      get() {
        return stateValue;
      },
      set(v) {
        try {
          sortResourceList(v && v.resourceList);
        } catch (e) {
          console.error('[wl-dur] reorder resourceList failed', e);
        }
        stateValue = v;
      },
    });
  } catch (e) {
    console.error('[wl-dur] define __INITIAL_STATE__ hook failed', e);
  }

  // ---- 客户端分页/加载更多走的接口,顺带也按时长排,保证翻页内容一致 ----
  const API_RE = /\/x\/v2\/medialist\/toview\/web/;

  function arcDuration(item) {
    const d = item && item.arc_info && item.arc_info.duration;
    return typeof d === 'number' ? d : -1;
  }

  function reorder(json) {
    const data = json && json.data;
    const list = data && data.list;
    if (!Array.isArray(list)) return json;
    list.forEach((it) => {
      const d = arcDuration(it);
      if (it && it.bvid && d >= 0) durByBvid.set(it.bvid, d);
    });
    list.sort(bySeconds(arcDuration));
    list.forEach((it, i) => {
      it.index = i;
      it.seq = i;
    });
    return json;
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!API_RE.test(url)) return origFetch.call(this, input, init);

    // 稍后再看上限 100,一次性取全,避免分页只对单页排序
    let newInput = input;
    try {
      const u = new URL(url, location.origin);
      u.searchParams.set('ps', '100');
      const newUrl = u.toString();
      newInput = typeof input === 'string' ? newUrl : new Request(newUrl, input);
    } catch (e) {
      console.error('[wl-dur] rewrite url failed', e);
    }

    return origFetch.call(this, newInput, init).then((resp) =>
      resp
        .clone()
        .json()
        .then((json) => {
          const sorted = reorder(json);
          return new Response(JSON.stringify(sorted), {
            status: resp.status,
            statusText: resp.statusText,
            headers: resp.headers,
          });
        })
        .catch((e) => {
          console.error('[wl-dur] reorder failed, fall back to original', e);
          return resp;
        })
    );
  };

  // ---- 队列也是懒加载的:不滚到底只渲染前几页 ----
  // 自动把播放队列容器滚到底,把所有视频都加载进 resourceList,
  // 每次有新内容补进来就就地重排,直到数量稳定,保证是全局时长顺序。
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function queueScroller() {
    const content = document.querySelector('.action-list-content');
    let el = content;
    while (el) {
      const cs = getComputedStyle(el);
      if (/auto|scroll/.test(cs.overflowY) && el.scrollHeight > el.clientHeight) return el;
      el = el.parentElement;
    }
    return content && content.parentElement;
  }

  async function loadAllAndSort() {
    // 等队列面板挂载
    for (let i = 0; i < 40 && !document.querySelector('.action-list-content'); i++) {
      await sleep(250);
    }
    let stable = 0;
    let lastLen = -1;
    for (let i = 0; i < 80 && stable < 3; i++) {
      const scroller = queueScroller();
      if (scroller) scroller.scrollTo(0, scroller.scrollHeight);
      await sleep(350);
      sortResourceList(currentResourceList());
      const len = (currentResourceList() || []).length;
      if (len === lastLen) {
        stable++;
      } else {
        stable = 0;
        lastLen = len;
      }
    }
    sortResourceList(currentResourceList());
    const scroller = queueScroller();
    if (scroller) scroller.scrollTo(0, 0);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => loadAllAndSort());
  } else {
    loadAllAndSort();
  }
})();
