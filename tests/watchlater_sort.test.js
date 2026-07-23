const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const playerSource = fs.readFileSync(
  path.join(root, 'bilibili_watchlater_play_duration_sort.user.js'),
  'utf8',
);
const toggleSource = fs.readFileSync(
  path.join(root, 'bilibili_watchlater_toggle.user.js'),
  'utf8',
);

const apiItems = [
  {
    bvid: 'BV_LOW_DURATION',
    cid: 1,
    arc_info: {
      aid: 1,
      cid: 1,
      duration: 100,
      pages: [{ cid: 1, duration: 100, page: 1, part: 'Low duration' }],
      stat: { view: 5000 },
      title: 'Low duration',
    },
  },
  {
    bvid: 'BV_LOW_VIEWS',
    cid: 2,
    arc_info: {
      aid: 2,
      cid: 2,
      duration: 200,
      pages: [{ cid: 2, duration: 200, page: 1, part: 'Low views' }],
      stat: { view: 100 },
      title: 'Low views',
    },
  },
  {
    bvid: 'BV_HIGH_DURATION',
    cid: 3,
    arc_info: {
      aid: 3,
      cid: 3,
      duration: 300,
      pages: [{ cid: 3, duration: 300, page: 1, part: 'High duration' }],
      stat: { view: 1000 },
      title: 'High duration',
    },
  },
  {
    bvid: 'BV_MISSING_VIEWS',
    cid: 4,
    arc_info: {
      aid: 4,
      cid: 4,
      duration: 150,
      pages: [{ cid: 4, duration: 150, page: 1, part: 'Missing views' }],
      stat: {},
      title: 'Missing views',
    },
  },
];

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function runPlayer(search) {
  let fetchCalls = 0;
  const resourceList = [{ bvid: 'ORIGINAL' }];
  const sandbox = {
    URLSearchParams,
    console,
    document: { readyState: 'complete' },
    fetch: async () => {
      fetchCalls += 1;
      return { json: async () => ({ data: { list: apiItems } }) };
    },
    location: { search },
    setTimeout: (callback) => queueMicrotask(callback),
    window: { __INITIAL_STATE__: { resourceList } },
  };
  vm.runInNewContext(playerSource, sandbox);
  await settle();
  return {
    bvids: resourceList.map((item) => item.bvid),
    fetchCalls,
  };
}

test('player sorts the full queue by views and preserves duration sorting', async () => {
  assert.deepEqual((await runPlayer('?wl_views=desc')).bvids, [
    'BV_LOW_DURATION',
    'BV_HIGH_DURATION',
    'BV_LOW_VIEWS',
    'BV_MISSING_VIEWS',
  ]);
  assert.deepEqual((await runPlayer('?wl_views=asc')).bvids, [
    'BV_LOW_VIEWS',
    'BV_HIGH_DURATION',
    'BV_LOW_DURATION',
    'BV_MISSING_VIEWS',
  ]);
  assert.deepEqual((await runPlayer('?wl_dur=desc')).bvids, [
    'BV_HIGH_DURATION',
    'BV_LOW_VIEWS',
    'BV_MISSING_VIEWS',
    'BV_LOW_DURATION',
  ]);
  assert.deepEqual((await runPlayer('?wl_dur=asc')).bvids, [
    'BV_LOW_DURATION',
    'BV_MISSING_VIEWS',
    'BV_LOW_VIEWS',
    'BV_HIGH_DURATION',
  ]);
  assert.deepEqual(await runPlayer(''), {
    bvids: ['ORIGINAL'],
    fetchCalls: 0,
  });
});

function createClassList() {
  const values = new Set();
  return {
    add: (...names) => names.forEach((name) => values.add(name)),
    remove: (...names) => names.forEach((name) => values.delete(name)),
  };
}

function createElement(tagName) {
  const listeners = new Map();
  return {
    tagName,
    childNodes: [],
    children: [],
    classList: createClassList(),
    className: '',
    textContent: '',
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    dispatch(type) {
      listeners.get(type)?.();
    },
    insertBefore(child) {
      this.childNodes.unshift(child);
    },
    querySelector() {
      return null;
    },
  };
}

function createCard(bvid) {
  const link = {
    getAttribute: () => `/list/watchlater?bvid=${bvid}`,
  };
  return {
    bvid,
    querySelector: () => link,
    querySelectorAll: () => [],
  };
}

async function runToggle(sortLabel) {
  const documentListeners = new Map();
  const orderLabel = { nodeType: 3, nodeValue: '最近添加 ' };
  const popover = createElement('div');
  popover.querySelector = (selector) => (
    selector === '.wl-dur-menu'
      ? popover.children.find((child) => child.className === 'wl-dur-menu') || null
      : null
  );
  const orderButton = createElement('button');
  orderButton.childNodes = [orderLabel];
  orderButton.closest = () => popover;

  let cardOrder = [
    createCard('BV_LOW_DURATION'),
    createCard('BV_LOW_VIEWS'),
    createCard('BV_HIGH_DURATION'),
    createCard('BV_MISSING_VIEWS'),
  ];
  const section = {
    appendChild(card) {
      cardOrder = cardOrder.filter((item) => item !== card);
      cardOrder.push(card);
    },
    querySelectorAll: () => cardOrder.slice(),
  };
  const document = {
    documentElement: { scrollTo() {} },
    head: { appendChild() {} },
    scrollingElement: { scrollTo() {} },
    addEventListener(type, listener) {
      const listeners = documentListeners.get(type) || [];
      listeners.push(listener);
      documentListeners.set(type, listeners);
    },
    createElement,
    createTextNode: (text) => ({ nodeType: 3, nodeValue: text }),
    querySelector(selector) {
      if (selector === 'button.order-btn') return orderButton;
      if (selector === 'section.watchlater-list-container') return section;
      if (selector === '.watchlater-list-empty') {
        return { getClientRects: () => [1], textContent: '已经探索到底了～' };
      }
      return null;
    },
    querySelectorAll: () => [],
  };
  const sandbox = {
    Date,
    Map,
    MouseEvent: class {},
    Node: { TEXT_NODE: 3 },
    PointerEvent: class {},
    URL,
    console,
    document,
    fetch: async () => ({ json: async () => ({ data: { list: apiItems } }) }),
    location: {
      origin: 'https://www.bilibili.com',
      protocol: 'https:',
    },
    clearInterval() {},
    setInterval: (callback) => {
      queueMicrotask(callback);
      return 1;
    },
    setTimeout: (callback) => queueMicrotask(callback),
    window: {},
  };
  vm.runInNewContext(toggleSource, sandbox);
  await settle();

  const menu = popover.children.find((child) => child.className === 'wl-dur-menu');
  const sortButton = menu.children.find((child) => child.textContent === sortLabel);
  sortButton.dispatch('click');
  await settle();

  const videoLink = {
    href: '/list/watchlater?bvid=BV_LOW_DURATION&wl_dur=asc',
    getAttribute() {
      return this.href;
    },
    setAttribute(name, value) {
      assert.equal(name, 'href');
      this.href = value;
    },
  };
  const clickEvent = {
    target: {
      closest(selector) {
        return selector === 'a[href*="watchlater"]' ? videoLink : null;
      },
    },
  };
  documentListeners.get('click').forEach((listener) => listener(clickEvent));

  return {
    bvids: cardOrder.map((card) => card.bvid),
    label: orderLabel.nodeValue.trim(),
    videoUrl: new URL(videoLink.href),
  };
}

test('list menu sorts by views and carries only wl_views into video links', async () => {
  const descending = await runToggle('播放最多');
  assert.deepEqual(descending.bvids, [
    'BV_LOW_DURATION',
    'BV_HIGH_DURATION',
    'BV_LOW_VIEWS',
    'BV_MISSING_VIEWS',
  ]);
  assert.equal(descending.label, '播放最多');
  assert.equal(descending.videoUrl.searchParams.get('wl_views'), 'desc');
  assert.equal(descending.videoUrl.searchParams.has('wl_dur'), false);

  const ascending = await runToggle('播放最少');
  assert.deepEqual(ascending.bvids, [
    'BV_LOW_VIEWS',
    'BV_HIGH_DURATION',
    'BV_LOW_DURATION',
    'BV_MISSING_VIEWS',
  ]);
  assert.equal(ascending.label, '播放最少');
  assert.equal(ascending.videoUrl.searchParams.get('wl_views'), 'asc');
  assert.equal(ascending.videoUrl.searchParams.has('wl_dur'), false);
});