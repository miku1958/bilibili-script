// ==UserScript==
// @name         Bilibili 稍后再看播放页时长排序
// @namespace    http://tampermonkey.net/
// @version      2026.6.28.1
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

  // ---- 主播放列表:服务端把它直接塞进 HTML 的 window.__INITIAL_STATE__.resourceList ----
  // 播放器、右侧播放队列、自动连播都读这个数组,客户端请求改不到它。
  // resourceList 项没有 duration 字段,但每个 pages[].duration 求和就是总时长。
  function resourceDuration(item) {
    const pages = item && item.pages;
    if (!Array.isArray(pages)) return -1;
    return pages.reduce((acc, p) => acc + (p.duration || 0), 0);
  }

  function reorderResourceList(state) {
    const list = state && state.resourceList;
    if (!Array.isArray(list) || list.length === 0) return;
    list.sort(bySeconds(resourceDuration));
    list.forEach((it, i) => {
      it.index = i;
      it.isHead = i === 0;
      it.isTail = i === list.length - 1;
    });
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
          reorderResourceList(v);
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
})();
