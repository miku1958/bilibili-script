// ==UserScript==
// @name         Bilibili 稍后再看播放页时长排序
// @namespace    http://tampermonkey.net/
// @version      2026.6.28.3
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
  // 播放器、右侧播放队列、自动连播都读这个数组(原地 sort 会让队列实时重排)。
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

  // ---- 只"观察"列表接口,记录每个视频的时长,绝不改请求或响应 ----
  // 之前重建 Response(连同原始 content-encoding/length 头)会让播放器解码失败,
  // 报"网络状况异常";而改写初始 resourceList 顺序又会打乱分页游标。所以这里只读不改,
  // 让播放器按原生分页正常加载,排序完全交给下面加载完成后的一次性重排。
  const API_RE = /\/x\/v2\/medialist\/toview\/web/;

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const promise = origFetch.call(this, input, init);
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (API_RE.test(url)) {
      promise
        .then((resp) => resp.clone().json())
        .then((json) => {
          const list = json && json.data && json.data.list;
          if (!Array.isArray(list)) return;
          list.forEach((it) => {
            const d = it && it.arc_info && it.arc_info.duration;
            if (it && it.bvid && typeof d === 'number') durByBvid.set(it.bvid, d);
          });
        })
        .catch(() => {});
    }
    return promise;
  };

  // ---- 队列也是懒加载的:不滚到底只渲染前几页 ----
  // 自动把播放队列容器滚到底,触发播放器原生分页把所有视频加载进 resourceList,
  // 数量稳定后再一次性按时长就地重排(reactive 数组,原地 sort 队列会实时更新)。
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
    // 不停滚到底加载,直到数量稳定(加载期间不重排,免得打乱分页与滚动位置)
    let stable = 0;
    let lastLen = -1;
    for (let i = 0; i < 200 && stable < 4; i++) {
      const scroller = queueScroller();
      if (scroller) scroller.scrollTo(0, scroller.scrollHeight);
      await sleep(400);
      const len = (currentResourceList() || []).length;
      if (len === lastLen) {
        stable++;
      } else {
        stable = 0;
        lastLen = len;
      }
    }
    // 全部加载完,一次性按时长重排
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
