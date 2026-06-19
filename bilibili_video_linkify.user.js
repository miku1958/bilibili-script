// ==UserScript==
// @name         Bilibili 视频简介/评论 URL 可点击
// @namespace    http://tampermonkey.net/
// @version      2026.6.19
// @description  把 bilibili 视频详情页(/video/BVxxx)简介和评论区里的纯文本 URL 转成可点击的链接
// @author       taozhuang
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/list/*
// @match        https://www.bilibili.com/festival/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  if (window._biliVideoLinkifyRunning) return;
  window._biliVideoLinkifyRunning = true;

  // URL 匹配:常见 http/https 链接,允许末尾不带标点
  const URL_RE = /https?:\/\/[^\s<>"'，。、]+[^\s<>"'，。、.,;:!?)\]]/g;

  // 简介相关容器和评论区入口
  const TARGET_SELECTORS = [
    '#v_desc',
    '#commentapp',
    'bili-comments'
  ];

  const TEST_PAGES = Object.freeze([
    {
      area: 'intro',
      url: 'https://www.bilibili.com/video/BV1AVdwBmEjA/',
      expectedUrls: [
        'https://store.epicgames.com/zh-CN/p/trash-goblin-cd5fd7',
        'https://store.epicgames.com/zh-CN/p/arranger-a-rolepuzzling-adventure-dbfde7'
      ]
    },
    {
      area: 'intro',
      url: 'https://www.bilibili.com/video/BV1qfjA67Env',
      expectedUrls: [
        'https://store.epicgames.com/p/citizen-sleeper-944858',
        'https://store.epicgames.com/p/robobeat-5f084b'
      ]
    },
    {
      area: 'comments',
      url: 'https://www.bilibili.com/video/BV1NqRyBMEeL',
      expectedUrls: [
        'https://pan.baidu.com/s/1RrCmjsOfY_QfXHMXHaMn2A?pwd=igno'
      ]
    }
  ]);

  const SKIP_TAGS = new Set(['A', 'SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'CODE']);
  const observedRoots = new WeakSet();
  let obs;

  function observeRoot(root) {
    if (!root || (root.nodeType !== 1 && root.nodeType !== 11) || observedRoots.has(root) || !obs) return;
    observedRoots.add(root);
    obs.observe(root, { childList: true, subtree: true, characterData: true });
  }

  function linkifyTextNode(textNode) {
    const text = textNode.nodeValue;
    URL_RE.lastIndex = 0;
    if (!URL_RE.test(text)) return false;
    URL_RE.lastIndex = 0;

    const frag = document.createDocumentFragment();
    let last = 0;
    let m;
    while ((m = URL_RE.exec(text)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const a = document.createElement('a');
      a.href = m[0];
      a.textContent = m[0];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.className = '_bili_linkify';
      a.style.color = '#00a1d6';
      a.style.textDecoration = 'underline';
      a.style.wordBreak = 'break-all';
      // 阻止 Bilibili 自己的"点击展开"切换捕获
      a.addEventListener('click', (e) => e.stopPropagation(), true);
      frag.appendChild(a);
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    textNode.parentNode.replaceChild(frag, textNode);
    return true;
  }

  function walk(root) {
    if (!root || (root.nodeType !== 1 && root.nodeType !== 11)) return false;
    observeRoot(root);
    if (root.nodeType === 1) {
      if (SKIP_TAGS.has(root.tagName)) return false;
      if (root.classList && root.classList.contains('_bili_linkify')) return false;
    }

    let changed = false;
    // 先收集快照,避免边遍历边修改
    const textNodes = [];
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        if (p.classList && p.classList.contains('_bili_linkify')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while ((n = tw.nextNode())) textNodes.push(n);
    for (const tn of textNodes) {
      if (linkifyTextNode(tn)) changed = true;
    }

    const shadowHosts = [];
    if (root.nodeType === 1 && root.shadowRoot) shadowHosts.push(root);
    const ew = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(el) {
        if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
        if (el.classList && el.classList.contains('_bili_linkify')) return NodeFilter.FILTER_REJECT;
        return el.shadowRoot ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    let el;
    while ((el = ew.nextNode())) shadowHosts.push(el);
    for (const host of shadowHosts) {
      if (walk(host.shadowRoot)) changed = true;
    }

    return changed;
  }

  function processAll(root = document) {
    observeRoot(root);
    for (const sel of TARGET_SELECTORS) {
      if (root.nodeType === 1 && root.matches(sel)) walk(root);
      root.querySelectorAll(sel).forEach((el) => walk(el));
    }
  }

  let pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    // 用 setTimeout 而不是 requestAnimationFrame:背景标签页 rAF 会被节流到
    // 不触发,导致简介一直没被链接化。
    setTimeout(() => {
      pending = false;
      processAll();
    }, 0);
  }

  obs = new MutationObserver((muts) => {
    // 任何目标容器内的变更都触发一次扫描;我们已用 _bili_linkify 标记跳过自身产物,不会无限循环
    for (const m of muts) {
      if (m.type === 'childList' && m.addedNodes.length) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.classList && node.classList.contains('_bili_linkify')) return;
        }
      }
    }
    schedule();
  });

  observeRoot(document.body);

  // 初次执行 + SPA 路由切换时再跑一次
  processAll();
  schedule();
  window.addEventListener('popstate', schedule);
  // bilibili 用 pushState 做软导航,劫持一下
  const _push = history.pushState;
  history.pushState = function () {
    const r = _push.apply(this, arguments);
    setTimeout(schedule, 500);
    return r;
  };
})();
