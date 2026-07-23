// ==UserScript==
// @name         Bilibili 稍后再看播放页时长排序
// @namespace    http://tampermonkey.net/
// @version      2026.7.23
// @description  根据 URL 参数 wl_dur 或 wl_views 对稍后再看播放器的播放列表按时长或播放量排序
// @author       taozhuang
// @match        https://www.bilibili.com/list/watchlater*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // 排序方式直接写在 URL 里:wl_dur 按时长,wl_views 按播放量,值为 desc 或 asc。
  // 没有有效参数就完全不介入,保持播放器原本(按添加时间)的顺序。
  const params = new URLSearchParams(location.search);
  const durationDir = params.get('wl_dur');
  const viewsDir = params.get('wl_views');
  const sortMetric = viewsDir === 'desc' || viewsDir === 'asc'
    ? 'views'
    : durationDir === 'desc' || durationDir === 'asc' ? 'duration' : null;
  if (!sortMetric) return;
  const dir = sortMetric === 'views' ? viewsDir : durationDir;
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

  function arcDuration(item) {
    const d = item && item.arc_info && item.arc_info.duration;
    return typeof d === 'number' ? d : -1;
  }

  function arcViews(item) {
    const views = item && item.arc_info && item.arc_info.stat && item.arc_info.stat.view;
    return typeof views === 'number' ? views : null;
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
    list.sort(byValue(sortMetric === 'views' ? arcViews : arcDuration));
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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => loadAllAndSort());
  } else {
    loadAllAndSort();
  }
})();
