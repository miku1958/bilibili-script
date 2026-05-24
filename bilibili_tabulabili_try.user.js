// ==UserScript==
// @name         Bilibili TabulaBili JS Ext Try
// @namespace    http://tampermonkey.net/
// @version      2026.5.24.11
// @description  对脚本加载后的 B 站首页推荐请求按开关尝试去凭据并延续匿名刷新序号
// @author       taozhuang
// @source       https://github.com/tjsky/TabulaBili
// @match        https://www.bilibili.com/
// @match        https://www.bilibili.com/?*
// @match        https://www.bilibili.com/index.html*
// @connect      127.0.0.1
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const pageWindow = typeof unsafeWindow === 'object' && unsafeWindow ? unsafeWindow : window;
  const VERSION = '2026.5.24.11';
  const PREFIX = '[TabulaBiliTry]';
  const MAX_LOGS = 500;
  const LOG_ENDPOINT = 'http://127.0.0.1:17890/tabulabili-log';
  const KEEP_PERSONALIZED_KEY = 'tabulaBiliTryKeepPersonalized';
  const ANONYMOUS_REFRESH_INDEX_KEY = 'tabulaBiliTryAnonymousRefreshIndex';
  // 保留 fresh_idx/fetch_row/brush/y_num 和 last_showlist，否则匿名换一换容易重复同一批内容。
  const ANONYMOUS_QUERY_PARAMS = new Set([
    'screen',
    'seo_info',
    'tt_exp',
    'w_rid',
    'wts'
  ]);
  const installStartedAt = Date.now();

  if (pageWindow.__tabulaBiliTryInstalled) {
    console.info(PREFIX, 'already-installed', { version: pageWindow.__tabulaBiliTryInstalled });
    return;
  }
  pageWindow.__tabulaBiliTryInstalled = VERSION;

  const logs = pageWindow.__tabulaBiliTryLogs = pageWindow.__tabulaBiliTryLogs || [];
  let keepPersonalized = readKeepPersonalized();
  let modeSwitchMounted = false;

  function nowOffset() {
    return `+${Date.now() - installStartedAt}ms`;
  }

  function log(level, event, detail) {
    const entry = {
      at: new Date().toISOString(),
      offset: nowOffset(),
      event,
      detail: detail || null
    };
    logs.push(entry);
    if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
    const printer = console[level] || console.log;
    printer.call(console, PREFIX, event, entry.detail, entry.offset);
    sendLog(entry);
  }

  function sendLog(entry) {
    try {
      const body = JSON.stringify(entry);
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'POST',
          url: LOG_ENDPOINT,
          headers: { 'content-type': 'text/plain;charset=UTF-8' },
          data: body,
          onerror: () => {},
          ontimeout: () => {},
          timeout: 3000
        });
        return;
      }
      if (navigator.sendBeacon && navigator.sendBeacon(LOG_ENDPOINT, body)) return;
      pageWindow.fetch(LOG_ENDPOINT, {
        method: 'POST',
        mode: 'no-cors',
        keepalive: true,
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        body
      }).catch(() => {});
    } catch {
      // 本地日志服务不可用时,不影响页面内实验逻辑。
    }
  }

  function readKeepPersonalized() {
    try {
      if (typeof GM_getValue === 'function') return Boolean(GM_getValue(KEEP_PERSONALIZED_KEY, false));
    } catch {}
    try {
      return pageWindow.localStorage.getItem(KEEP_PERSONALIZED_KEY) === '1';
    } catch {
      return false;
    }
  }

  function writeKeepPersonalized(value) {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(KEEP_PERSONALIZED_KEY, Boolean(value));
        return;
      }
    } catch {}
    try {
      pageWindow.localStorage.setItem(KEEP_PERSONALIZED_KEY, value ? '1' : '0');
    } catch {}
  }

  function createAnonymousUniqId() {
    const randomPart = Math.floor(Math.random() * 1e6).toString().padStart(6, '0');
    return `${Date.now()}${randomPart}`.slice(0, 16);
  }

  function anonymousUniqId() {
    return createAnonymousUniqId();
  }

  function readNumberValue(key, fallback) {
    try {
      if (typeof GM_getValue === 'function') {
        const value = Number(GM_getValue(key, fallback));
        return Number.isFinite(value) ? value : fallback;
      }
    } catch {}
    try {
      const value = Number(pageWindow.localStorage.getItem(key));
      return Number.isFinite(value) ? value : fallback;
    } catch {
      return fallback;
    }
  }

  function writeNumberValue(key, value) {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(key, value);
        return;
      }
    } catch {}
    try {
      pageWindow.localStorage.setItem(key, String(value));
    } catch {}
  }

  function nextAnonymousRefreshIndex(originalIndex) {
    const storedIndex = readNumberValue(ANONYMOUS_REFRESH_INDEX_KEY, 0);
    const parsedOriginal = Number(originalIndex || 0);
    const baseIndex = Math.max(storedIndex, Number.isFinite(parsedOriginal) ? parsedOriginal - 1 : 0);
    const nextIndex = baseIndex >= 50 ? 1 : baseIndex + 1;
    writeNumberValue(ANONYMOUS_REFRESH_INDEX_KEY, nextIndex);
    return nextIndex;
  }

  function requestMode() {
    return keepPersonalized ? 'personalized' : 'anonymous';
  }

  function setKeepPersonalized(value, reason) {
    const nextValue = Boolean(value);
    if (keepPersonalized === nextValue) return;
    keepPersonalized = nextValue;
    writeKeepPersonalized(keepPersonalized);
    updateModeSwitch();
    log('info', 'mode-changed', {
      reason,
      keepPersonalized,
      requestMode: requestMode()
    });
  }

  function toUrlString(input) {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    if (input && typeof input.url === 'string') return input.url;
    return '';
  }

  function isTargetApi(input) {
    const rawUrl = toUrlString(input);
    if (!rawUrl) return false;
    try {
      const url = new URL(rawUrl, location.href);
      if (url.hostname !== 'api.bilibili.com') return false;
      const haystack = `${url.pathname}${url.search}`;
      return haystack.includes('/x/web-interface') && haystack.includes('index/top') && haystack.includes('rcmd');
    } catch (error) {
      log('warn', 'target-url-parse-failed', { rawUrl, message: error.message });
      return false;
    }
  }

  function shortUrl(input) {
    const rawUrl = toUrlString(input);
    if (!rawUrl) return '';
    try {
      const url = new URL(rawUrl, location.href);
      return `${url.origin}${url.pathname}`;
    } catch {
      return rawUrl.slice(0, 160);
    }
  }

  function targetUrlInfo(input) {
    const rawUrl = toUrlString(input);
    if (!rawUrl) return null;
    try {
      const url = new URL(rawUrl, location.href);
      const params = {};
      url.searchParams.forEach((value, key) => {
        if (key === 'w_rid') params[key] = `${value.slice(0, 8)}...`;
        else params[key] = value;
      });
      return {
        url: `${url.origin}${url.pathname}`,
        params
      };
    } catch {
      return { url: rawUrl.slice(0, 160), params: null };
    }
  }

  function anonymizeTargetUrl(input) {
    const rawUrl = toUrlString(input);
    if (!rawUrl) return null;
    try {
      const url = new URL(rawUrl, location.href);
      const removedParams = [];
      for (const key of ANONYMOUS_QUERY_PARAMS) {
        if (url.searchParams.has(key)) {
          url.searchParams.delete(key);
          removedParams.push(key);
        }
      }
      const originalUniqId = url.searchParams.get('uniq_id');
      const nextUniqId = anonymousUniqId();
      url.searchParams.set('uniq_id', nextUniqId);
      const originalFreshIdx = url.searchParams.get('fresh_idx');
      const nextRefreshIndex = nextAnonymousRefreshIndex(originalFreshIdx);
      url.searchParams.set('fresh_idx', String(nextRefreshIndex));
      url.searchParams.set('fresh_idx_1h', String(nextRefreshIndex));
      url.searchParams.set('fetch_row', String(nextRefreshIndex));
      url.searchParams.set('brush', String(Math.max(0, nextRefreshIndex - 1)));
      if (!url.searchParams.has('y_num')) url.searchParams.set('y_num', '5');
      if (!url.searchParams.has('last_y_num')) url.searchParams.set('last_y_num', '5');
      if (!url.searchParams.has('ps')) url.searchParams.set('ps', '10');
      return {
        url: url.href,
        removedParams,
        originalUniqId,
        nextUniqId,
        originalFreshIdx,
        nextRefreshIndex,
        changed: true
      };
    } catch (error) {
      log('warn', 'anonymous-url-parse-failed', { rawUrl, message: error.message });
      return null;
    }
  }

  function extractFeedItems(payload) {
    const data = payload && payload.data;
    const candidates = [
      data && data.item,
      data && data.items,
      data && data.list,
      payload && payload.item,
      payload && payload.items
    ];
    const items = candidates.find((candidate) => Array.isArray(candidate)) || [];
    return items.slice(0, 12).map((item) => ({
      title: item && (item.title || item.name || item.card_title || ''),
      goto: item && item.goto,
      bvid: item && item.bvid,
      owner: item && item.owner && item.owner.name || item && item.author || item && item.up_name || '',
      tname: item && (item.tname || item && item.args && item.args.tname || ''),
      reason: item && item.rcmd_reason && (item.rcmd_reason.content || item.rcmd_reason.reason_type) || item && item.reason || ''
    }));
  }

  function logFeedSample(response, input, mode) {
    try {
      response.clone().json().then((payload) => {
        log('info', 'feed-sample', {
          requestMode: mode,
          code: payload && payload.code,
          url: targetUrlInfo(input),
          items: extractFeedItems(payload)
        });
      }).catch((error) => {
        log('warn', 'feed-sample-error', {
          requestMode: mode,
          url: shortUrl(input),
          message: error && error.message ? error.message : String(error)
        });
      });
    } catch (error) {
      log('warn', 'feed-sample-clone-error', {
        requestMode: mode,
        url: shortUrl(input),
        message: error && error.message ? error.message : String(error)
      });
    }
  }

  function installFetchHook() {
    const rawFetch = pageWindow.fetch;
    if (typeof rawFetch !== 'function') {
      log('warn', 'fetch-hook-skip', { reason: 'window.fetch is not a function' });
      return;
    }

    pageWindow.fetch = function tabulaBiliFetch(input, init) {
      if (!isTargetApi(input)) return rawFetch.apply(this, arguments);

      const originalCredentials = init && Object.prototype.hasOwnProperty.call(init, 'credentials')
        ? init.credentials
        : input && typeof input.credentials === 'string'
          ? input.credentials
          : '(browser default)';
      if (keepPersonalized) {
        log('info', 'fetch-target-keep-personalized', {
          url: shortUrl(input),
          originalCredentials,
          requestMode: requestMode(),
          inputType: input && input.constructor ? input.constructor.name : typeof input,
          hasInit: !!init
        });

        return rawFetch.apply(this, arguments).then((response) => {
          logFeedSample(response, input, requestMode());
          log('info', 'fetch-target-personalized-response', {
            url: shortUrl(input),
            status: response.status,
            ok: response.ok,
            redirected: response.redirected,
            type: response.type
          });
          return response;
        }, (error) => {
          log('warn', 'fetch-target-personalized-error', {
            url: shortUrl(input),
            message: error && error.message ? error.message : String(error)
          });
          throw error;
        });
      }

      const anonymousUrl = anonymizeTargetUrl(input);
      const nextInput = anonymousUrl && anonymousUrl.changed && (typeof input === 'string' || input instanceof URL)
        ? anonymousUrl.url
        : input;
      const nextInit = Object.assign({}, init || {}, { credentials: 'omit' });

      log('info', 'fetch-target-credentials-omitted', {
        url: shortUrl(input),
        nextUrl: shortUrl(nextInput),
        removedParams: anonymousUrl ? anonymousUrl.removedParams : [],
        originalUniqId: anonymousUrl ? anonymousUrl.originalUniqId : null,
        nextUniqId: anonymousUrl ? anonymousUrl.nextUniqId : null,
        originalFreshIdx: anonymousUrl ? anonymousUrl.originalFreshIdx : null,
        nextRefreshIndex: anonymousUrl ? anonymousUrl.nextRefreshIndex : null,
        originalCredentials,
        nextCredentials: nextInit.credentials,
        requestMode: requestMode(),
        inputType: input && input.constructor ? input.constructor.name : typeof input,
        hasInit: !!init
      });

      return rawFetch.call(this, nextInput, nextInit).then((response) => {
        logFeedSample(response, nextInput, requestMode());
        log('info', 'fetch-target-response', {
          url: shortUrl(nextInput),
          status: response.status,
          ok: response.ok,
          redirected: response.redirected,
          type: response.type
        });
        return response;
      }, (error) => {
        log('warn', 'fetch-target-error', {
          url: shortUrl(input),
          message: error && error.message ? error.message : String(error)
        });
        throw error;
      });
    };

    log('info', 'fetch-hook-installed', { ok: true });
  }

  function installXhrHook() {
    const RawXHR = pageWindow.XMLHttpRequest;
    if (!RawXHR || !RawXHR.prototype) {
      log('warn', 'xhr-hook-skip', { reason: 'XMLHttpRequest is not available' });
      return;
    }

    const rawOpen = RawXHR.prototype.open;
    const rawSend = RawXHR.prototype.send;

    RawXHR.prototype.open = function tabulaBiliOpen(method, url) {
      this.__tabulaBiliTryTarget = isTargetApi(url);
      this.__tabulaBiliTryMethod = method;
      const anonymousUrl = this.__tabulaBiliTryTarget && !keepPersonalized ? anonymizeTargetUrl(url) : null;
      const nextUrl = anonymousUrl && anonymousUrl.changed ? anonymousUrl.url : url;
      this.__tabulaBiliTryUrl = nextUrl;
      if (this.__tabulaBiliTryTarget) {
        log('info', 'xhr-target-open', {
          method,
          url: shortUrl(url),
          nextUrl: shortUrl(nextUrl),
          removedParams: anonymousUrl ? anonymousUrl.removedParams : [],
          originalUniqId: anonymousUrl ? anonymousUrl.originalUniqId : null,
          nextUniqId: anonymousUrl ? anonymousUrl.nextUniqId : null,
          originalFreshIdx: anonymousUrl ? anonymousUrl.originalFreshIdx : null,
          nextRefreshIndex: anonymousUrl ? anonymousUrl.nextRefreshIndex : null,
          requestMode: requestMode(),
          withCredentialsBeforeOpen: this.withCredentials
        });
      }
      const args = Array.prototype.slice.call(arguments);
      args[1] = nextUrl;
      return rawOpen.apply(this, args);
    };

    RawXHR.prototype.send = function tabulaBiliSend() {
      if (this.__tabulaBiliTryTarget) {
        const before = this.withCredentials;
        if (keepPersonalized) {
          log('info', 'xhr-target-keep-personalized', {
            method: this.__tabulaBiliTryMethod,
            url: shortUrl(this.__tabulaBiliTryUrl),
            requestMode: requestMode(),
            withCredentialsBeforeSend: before
          });
        } else {
          try {
            this.withCredentials = false;
          } catch (error) {
            log('warn', 'xhr-with-credentials-set-failed', {
              method: this.__tabulaBiliTryMethod,
              url: shortUrl(this.__tabulaBiliTryUrl),
              message: error.message
            });
          }
          log('info', 'xhr-target-send', {
            method: this.__tabulaBiliTryMethod,
            url: shortUrl(this.__tabulaBiliTryUrl),
            requestMode: requestMode(),
            withCredentialsBeforeSend: before,
            withCredentialsAfterPatch: this.withCredentials
          });
        }
        this.addEventListener('loadend', () => {
          log('info', 'xhr-target-loadend', {
            method: this.__tabulaBiliTryMethod,
            url: shortUrl(this.__tabulaBiliTryUrl),
            requestMode: requestMode(),
            status: this.status,
            responseURL: shortUrl(this.responseURL || this.__tabulaBiliTryUrl)
          });
        }, { once: true });
      }
      return rawSend.apply(this, arguments);
    };

    log('info', 'xhr-hook-installed', { ok: true });
  }

  function installModeSwitchStyle() {
    if (document.getElementById('tabula-bili-try-style')) return;
    const style = document.createElement('style');
    style.id = 'tabula-bili-try-style';
    style.textContent = `
      #tabula-bili-try-mode {
        box-sizing: border-box;
        display: block;
        flex: 0 0 100%;
        width: 100%;
        margin-top: 6px;
        line-height: 1;
        z-index: 20;
      }
      #tabula-bili-try-switch {
        position: relative;
        display: block;
        width: 56px;
        height: 24px;
        flex: none;
        cursor: pointer;
      }
      #tabula-bili-try-switch input {
        position: absolute;
        opacity: 0;
        pointer-events: none;
      }
      #tabula-bili-try-switch span {
        box-sizing: border-box;
        display: block;
        width: 100%;
        height: 100%;
        border: 1px solid rgba(0, 161, 214, 0.36);
        border-radius: 999px;
        background: #00a1d6;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
        transition: background 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease;
      }
      #tabula-bili-try-switch span::after {
        content: '';
        position: absolute;
        top: 3px;
        left: 3px;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        background: #fff;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.24);
        transition: left 0.18s ease;
      }
      #tabula-bili-try-switch:hover span,
      #tabula-bili-try-switch:focus-within span {
        box-shadow: 0 3px 10px rgba(0, 161, 214, 0.2);
      }
      #tabula-bili-try-switch input:checked + span {
        background: #10b981;
        border-color: rgba(16, 185, 129, 0.4);
      }
      #tabula-bili-try-switch input:checked + span::after {
        left: calc(100% - 21px);
      }
    `;
    document.documentElement.appendChild(style);
  }

  function syncModeSwitchWidth(rollButton) {
    const switchLabel = document.getElementById('tabula-bili-try-switch');
    if (!switchLabel || !rollButton) return;
    const width = Math.round(rollButton.getBoundingClientRect().width);
    if (width > 0) switchLabel.style.width = `${width}px`;
    switchLabel.style.marginLeft = `${Math.max(0, Math.round(rollButton.offsetLeft))}px`;
  }

  function updateModeSwitch() {
    const wrapper = document.getElementById('tabula-bili-try-mode');
    const input = document.getElementById('tabula-bili-try-keep-personalized');
    const switchLabel = document.getElementById('tabula-bili-try-switch');
    if (!wrapper || !input || !switchLabel) return;
    wrapper.dataset.mode = requestMode();
    input.checked = keepPersonalized;
    syncModeSwitchWidth(document.querySelector('.roll-btn'));
    const tooltip = keepPersonalized ? '当前：个性化推荐' : '当前：匿名推荐';
    wrapper.title = tooltip;
    switchLabel.title = tooltip;
    switchLabel.setAttribute('aria-label', tooltip);
    input.setAttribute('aria-label', tooltip);
  }

  function mountModeSwitch(rollButton) {
    if (!rollButton || modeSwitchMounted || document.getElementById('tabula-bili-try-mode')) {
      updateModeSwitch();
      return;
    }
    installModeSwitchStyle();

    const wrapper = document.createElement('div');
    wrapper.id = 'tabula-bili-try-mode';

    const switchLabel = document.createElement('label');
    switchLabel.id = 'tabula-bili-try-switch';

    const input = document.createElement('input');
    input.id = 'tabula-bili-try-keep-personalized';
    input.type = 'checkbox';
    input.checked = keepPersonalized;

    const slider = document.createElement('span');
    slider.setAttribute('aria-hidden', 'true');

    input.addEventListener('change', () => setKeepPersonalized(input.checked, 'switch'));

    switchLabel.appendChild(input);
    switchLabel.appendChild(slider);
    wrapper.appendChild(switchLabel);
    rollButton.insertAdjacentElement('afterend', wrapper);
    modeSwitchMounted = true;
    updateModeSwitch();
    log('info', 'mode-switch-mounted', { keepPersonalized, requestMode: requestMode() });
  }

  let rollClicked = false;
  let lastRollMissLogAt = 0;

  function tryClickRollButton(reason, force) {
    if (rollClicked && !force) return true;
    const button = document.querySelector('.roll-btn');
    if (!button) {
      const now = Date.now();
      if (now - lastRollMissLogAt > 1000) {
        lastRollMissLogAt = now;
        log('debug', 'roll-button-missing', { reason, readyState: document.readyState });
      }
      return false;
    }
    mountModeSwitch(button);

    if (keepPersonalized) {
      log('info', 'roll-button-skip-personalized-mode', { reason, requestMode: requestMode() });
      return true;
    }

    if (window.scrollY >= 100) {
      log('info', 'roll-button-skip-user-scrolled', { reason, scrollY: window.scrollY });
      return true;
    }

    rollClicked = true;
    log('info', 'roll-button-click', {
      reason,
      text: (button.textContent || '').trim(),
      scrollY: window.scrollY
    });
    button.click();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return true;
  }

  function installRollObserver() {
    const start = () => {
      if (tryClickRollButton('start')) return;
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (!mutation.addedNodes || mutation.addedNodes.length === 0) continue;
          if (tryClickRollButton('mutation')) {
            observer.disconnect();
            return;
          }
        }
      });
      observer.observe(document.documentElement || document, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        if (!rollClicked) log('warn', 'roll-button-timeout', { waitedMs: 10000, readyState: document.readyState });
      }, 10000);
      log('info', 'roll-observer-installed', { ok: true });
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
      log('info', 'roll-observer-wait-domcontentloaded', { readyState: document.readyState });
    } else {
      start();
    }
  }

  installFetchHook();
  installXhrHook();
  installRollObserver();

  pageWindow.__tabulaBiliTry = {
    version: VERSION,
    logs,
    isTargetApi,
    getKeepPersonalized: () => keepPersonalized,
    setKeepPersonalized: (value) => setKeepPersonalized(value, 'debug-api'),
    requestMode,
    clickRollButton: () => tryClickRollButton('manual', true),
    dumpLogs: () => logs.slice(),
    testTargetFetch: () => pageWindow.fetch('https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?tabula_bili_try=1', { credentials: 'include' })
  };

  log('info', 'installed', {
    version: VERSION,
    href: location.href,
    readyState: document.readyState,
    hasUnsafeWindow: pageWindow !== window,
    keepPersonalized,
    requestMode: requestMode()
  });
})();
