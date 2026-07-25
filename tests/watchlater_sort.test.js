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
    add_at: 100,
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
    add_at: 200,
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
    add_at: 300,
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
    add_at: 150,
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

async function runPlayer(search, items = apiItems) {
  let fetchCalls = 0;
  const resourceList = [{ bvid: 'ORIGINAL' }];
  const sandbox = {
    URLSearchParams,
    console,
    document: { readyState: 'complete' },
    fetch: async () => {
      fetchCalls += 1;
      return { json: async () => ({ data: { list: items } }) };
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
  assert.deepEqual((await runPlayer('?wl_added=asc')).bvids, [
    'BV_LOW_DURATION',
    'BV_MISSING_VIEWS',
    'BV_LOW_VIEWS',
    'BV_HIGH_DURATION',
  ]);
  assert.deepEqual((await runPlayer('?wl_added=desc')).bvids, [
    'BV_HIGH_DURATION',
    'BV_LOW_VIEWS',
    'BV_MISSING_VIEWS',
    'BV_LOW_DURATION',
  ]);
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

  const missingDuration = {
    ...apiItems[0],
    bvid: 'BV_MISSING_DURATION',
    arc_info: { ...apiItems[0].arc_info, duration: undefined },
  };
  assert.deepEqual((await runPlayer('?wl_dur=asc', [missingDuration, apiItems[0]])).bvids, [
    'BV_LOW_DURATION',
    'BV_MISSING_DURATION',
  ]);
  assert.deepEqual((await runPlayer('?wl_dur=desc', [missingDuration, apiItems[0]])).bvids, [
    'BV_LOW_DURATION',
    'BV_MISSING_DURATION',
  ]);
});

function createClassList() {
  const values = new Set();
  return {
    add: (...names) => names.forEach((name) => values.add(name)),
    remove: (...names) => names.forEach((name) => values.delete(name)),
    toggle(name, force) {
      const enabled = force === undefined ? !values.has(name) : force;
      if (enabled) values.add(name);
      else values.delete(name);
      return enabled;
    },
    contains: (name) => values.has(name),
  };
}

function createElement(tagName) {
  const listeners = new Map();
  const attributes = new Map();
  const element = {
    tagName,
    childNodes: [],
    children: [],
    classList: createClassList(),
    className: '',
    dataset: {},
    parentElement: null,
    textContent: '',
    title: '',
    addEventListener(type, listener) {
      const typeListeners = listeners.get(type) || [];
      typeListeners.push(listener);
      listeners.set(type, typeListeners);
    },
    appendChild(child) {
      this.children.push(child);
      child.parentElement = this;
      for (const observer of this._mutationObservers || []) queueMicrotask(observer);
      return child;
    },
    after(...nodes) {
      const siblings = this.parentElement.children;
      const index = siblings.indexOf(this);
      siblings.splice(index + 1, 0, ...nodes);
      nodes.forEach((node) => {
        node.parentElement = this.parentElement;
      });
    },
    dispatch(type, event = { type }) {
      (listeners.get(type) || []).forEach((listener) => listener(event));
    },
    dispatchEvent(event) {
      this.dispatch(event.type, event);
      return true;
    },
    click() {
      this.dispatch('click', {
        type: 'click',
        preventDefault() {},
        stopImmediatePropagation() {},
        stopPropagation() {},
      });
    },
    cloneNode() {
      const clone = createElement(this.tagName);
      clone.className = this.className;
      for (const className of this.className.split(/\s+/).filter(Boolean)) clone.classList.add(className);
      for (const [name, value] of attributes) clone.setAttribute(name, value);
      return clone;
    },
    insertBefore(child) {
      this.childNodes.unshift(child);
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll(selector) {
      if (selector === ':scope > .menu-popover__panel-item') {
        return this.children.filter((child) => child.classList.contains('menu-popover__panel-item'));
      }
      if (selector === '.wl-sort-menu-item') {
        return this.children.filter((child) => child.classList.contains('wl-sort-menu-item'));
      }
      return [];
    },
  };
  return element;
}

function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function createCard(apiItem) {
  const bvid = apiItem.bvid;
  const link = {
    getAttribute: () => `/list/watchlater?bvid=${bvid}`,
  };
  return {
    bvid,
    querySelector: (selector) => selector.includes('bvid=') ? link : null,
    querySelectorAll: (selector) => selector === '.bili-cover-card__stat'
      ? [{ textContent: formatDuration(apiItem.arc_info.duration) }]
      : [],
  };
}

async function flushAsyncWork() {
  for (let i = 0; i < 4; i++) await settle();
}

async function createToggleHarness() {
  const documentListeners = new Map();
  const orderLabel = { nodeType: 3, nodeValue: '最近添加 ' };
  const sortContainer = createElement('div');
  const popover = createElement('div');
  sortContainer.appendChild(popover);
  const orderButton = createElement('button');
  orderButton.childNodes = [orderLabel];
  orderButton.closest = () => popover;
  popover.appendChild(orderButton);

  const cardsByBvid = new Map(apiItems.map((item) => [item.bvid, createCard(item)]));
  let cardOrder = apiItems.map((item) => cardsByBvid.get(item.bvid));
  let fetchCalls = 0;
  let scrollCalls = 0;
  let panel = null;

  function nativeItem(label, cards) {
    const item = createElement('div');
    item.className = 'menu-popover__panel-item';
    item.classList.add('menu-popover__panel-item');
    item.textContent = label;
    item.addEventListener('click', () => {
      cardOrder = cards.slice();
      orderLabel.nodeValue = `${label} `;
      orderButton.textContent = label;
    });
    return item;
  }

  orderButton.addEventListener('mouseenter', () => {
    if (panel) return;
    const addedAscending = apiItems
      .slice()
      .sort((left, right) => left.add_at - right.add_at)
      .map((item) => cardsByBvid.get(item.bvid));
    panel = createElement('div');
    panel.className = 'menu-popover__panel';
    panel.classList.add('menu-popover__panel');
    panel.appendChild(nativeItem('最近添加', addedAscending.slice().reverse()));
    panel.appendChild(nativeItem('最早添加', addedAscending));
    popover.appendChild(panel);
  });

  const section = {
    appendChild(card) {
      cardOrder = cardOrder.filter((item) => item !== card);
      cardOrder.push(card);
    },
    querySelectorAll: () => cardOrder.slice(),
  };
  const document = {
    documentElement: { scrollTo() { scrollCalls += 1; } },
    head: { appendChild() {} },
    scrollingElement: { scrollTo() { scrollCalls += 1; } },
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
      if (selector === '.menu-popover__panel') return panel;
      if (selector === '.watchlater-list-empty') {
        return { getClientRects: () => [1], textContent: '已经探索到底了～' };
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '.menu-popover__panel-item') return panel ? panel.children.slice() : [];
      return [];
    },
  };
  class EventMock {
    constructor(type, options) {
      this.type = type;
      Object.assign(this, options);
    }
  }
  class MutationObserverMock {
    constructor(callback) {
      this.callback = callback;
    }
    observe(target) {
      target._mutationObservers ||= [];
      target._mutationObservers.push(this.callback);
    }
  }
  const sandbox = {
    Date,
    Map,
    MouseEvent: EventMock,
    MutationObserver: MutationObserverMock,
    Node: { TEXT_NODE: 3 },
    URL,
    console,
    document,
    fetch: async () => {
      fetchCalls += 1;
      return { json: async () => ({ data: { list: apiItems } }) };
    },
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
  await flushAsyncWork();

  const menuItems = new Map(
    (panel?.children || [])
      .filter((child) => child.classList.contains('wl-sort-menu-item'))
      .map((child) => [child.dataset.sortMetric, child]),
  );

  async function clickMetric(metric) {
    menuItems.get(metric).click();
    await flushAsyncWork();
  }

  function videoUrl(initialHref = '/list/watchlater?bvid=BV_LOW_DURATION&wl_dur=desc&wl_views=desc') {
    const videoLink = {
      href: initialHref,
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
    (documentListeners.get('click') || []).forEach((listener) => listener(clickEvent));
    return new URL(videoLink.href);
  }

  function state() {
    const controls = Array.from(menuItems, ([metric, item]) => ({
      active: item.getAttribute('aria-checked') === 'true',
      label: item.textContent,
      metric,
    }));
    return {
      bvids: cardOrder.map((card) => card.bvid),
      controls,
      fetchCalls,
      mainLabel: orderLabel.nodeValue.trim(),
      menuClassNames: Array.from(menuItems.values(), (item) => item.className),
      scrollCalls,
    };
  }

  return {
    clickMetric,
    state,
    videoUrl,
  };
}

function activeControl(state) {
  return state.controls.find((control) => control.active);
}

test('native sort menu defaults added time through native API without scrolling', async () => {
  const harness = await createToggleHarness();

  let state = harness.state();
  assert.deepEqual(state.controls.map((control) => control.label), ['添加时间', '播放量', '时长']);
  assert.deepEqual(activeControl(state), { active: true, label: '添加时间', metric: 'added' });
  assert.ok(state.menuClassNames.every((className) => /menu-popover__panel-item/.test(className)));
  assert.equal(state.mainLabel, '添加时间 · 旧到新');
  assert.equal(state.fetchCalls, 0);
  assert.equal(state.scrollCalls, 0);
  assert.deepEqual(state.bvids, [
    'BV_LOW_DURATION',
    'BV_MISSING_VIEWS',
    'BV_LOW_VIEWS',
    'BV_HIGH_DURATION',
  ]);
  assert.equal(harness.videoUrl().searchParams.get('wl_added'), 'asc');

  await harness.clickMetric('added');
  state = harness.state();
  assert.equal(state.mainLabel, '添加时间 · 新到旧');
  assert.equal(state.fetchCalls, 0);
  assert.equal(state.scrollCalls, 0);
  assert.deepEqual(state.bvids, [
    'BV_HIGH_DURATION',
    'BV_LOW_VIEWS',
    'BV_MISSING_VIEWS',
    'BV_LOW_DURATION',
  ]);
  assert.equal(harness.videoUrl().searchParams.get('wl_added'), 'desc');

  await harness.clickMetric('views');
  state = harness.state();
  assert.equal(activeControl(state).metric, 'views');
  assert.equal(state.mainLabel, '播放量 · 少到多');
  assert.deepEqual(state.bvids, [
    'BV_LOW_VIEWS',
    'BV_HIGH_DURATION',
    'BV_LOW_DURATION',
    'BV_MISSING_VIEWS',
  ]);
  assert.equal(harness.videoUrl().searchParams.get('wl_views'), 'asc');
  assert.equal(harness.videoUrl().searchParams.has('wl_added'), false);
  assert.equal(harness.videoUrl().searchParams.has('wl_dur'), false);

  await harness.clickMetric('views');
  state = harness.state();
  assert.equal(state.mainLabel, '播放量 · 多到少');
  assert.deepEqual(state.bvids, [
    'BV_LOW_DURATION',
    'BV_HIGH_DURATION',
    'BV_LOW_VIEWS',
    'BV_MISSING_VIEWS',
  ]);

  await harness.clickMetric('duration');
  state = harness.state();
  assert.equal(activeControl(state).metric, 'duration');
  assert.equal(state.mainLabel, '时长 · 短到长');
  assert.deepEqual(state.bvids, [
    'BV_LOW_DURATION',
    'BV_MISSING_VIEWS',
    'BV_LOW_VIEWS',
    'BV_HIGH_DURATION',
  ]);

  await harness.clickMetric('duration');
  state = harness.state();
  assert.equal(state.mainLabel, '时长 · 长到短');
  assert.deepEqual(state.bvids, [
    'BV_HIGH_DURATION',
    'BV_LOW_VIEWS',
    'BV_MISSING_VIEWS',
    'BV_LOW_DURATION',
  ]);
  assert.equal(harness.videoUrl().searchParams.get('wl_dur'), 'desc');
  assert.equal(harness.videoUrl().searchParams.has('wl_added'), false);
  assert.equal(harness.videoUrl().searchParams.has('wl_views'), false);

  await harness.clickMetric('views');
  state = harness.state();
  assert.equal(activeControl(state).metric, 'views');
  assert.equal(state.mainLabel, '播放量 · 少到多');

  await harness.clickMetric('added');
  state = harness.state();
  assert.equal(activeControl(state).metric, 'added');
  assert.equal(state.mainLabel, '添加时间 · 旧到新');
  assert.equal(harness.videoUrl().searchParams.get('wl_added'), 'asc');
  assert.equal(harness.videoUrl().searchParams.has('wl_dur'), false);
  assert.equal(harness.videoUrl().searchParams.has('wl_views'), false);
});