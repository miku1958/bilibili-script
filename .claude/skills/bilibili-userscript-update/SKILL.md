---
name: bilibili-userscript-update
description: 更新本仓库的 bilibili Tampermonkey userscript (*.user.js) 后,用 Chrome CDP 完成安装版更新与页面行为验证。涵盖 CDP-only 约束、Tampermonkey 更新页点击流程、运行版本/事件校验、以及本地验证服务与产物落点。当用户要更新/重装/验证 userscript、用 CDP 操作当前 Chrome、检查 window.__tabulaBiliTry 等运行时状态时使用。
---

# bilibili userscript 更新与验证

## When to Use

- 改完本仓库任一 `*.user.js`(如 `bilibili_tabulabili_try.user.js`)后,需要把安装版 Tampermonkey 更新到最新源并验证页面真实行为。
- 需要用 CDP 操作用户当前 Chrome 来检查 userscript 运行时状态(版本、事件、注入标记)。
- 启动本地验证服务、放置日志或临时产物时确认落点。

不适用:不涉及 Chrome / 安装版验证的纯源码编辑;非 bilibili 的脚本。

## Chrome 操作约束(CDP-only)

操作用户当前 Chrome **只能用 CDP**。禁止 AppleScript、GUI 键盘鼠标、截图、剪贴板或临时 Chrome profile 来更新脚本或验证页面。CDP 不可用时先停下说明阻塞,不要换其它方式绕过。

CDP 工具入口:

```sh
node ~/.claude/skills/chrome-cdp/scripts/cdp.mjs list
```

CDP 连接细节(默认 profile 端口、远程调试开关)见 chrome-cdp skill。

## Procedure — Tampermonkey 更新流程

以 `bilibili_tabulabili_try.user.js` 为例,改完源后:

1. 改完先跑 `node --check <file>.user.js`。VS Code 的诊断**不会**捕获 `.user.js` 语法错误(重复尾块会静默破坏脚本,Tampermonkey 会安装但跑不起来)。
2. 启动一个 workspace 内的本地验证服务,服务当前 userscript,并可选接收 `/tabulabili-log` 日志。服务结束后必须关闭,确认 `127.0.0.1:17890` 无监听残留。
3. 用 CDP 打开本地 userscript URL,触发 Tampermonkey 更新页:

   ```sh
   node ~/.claude/skills/chrome-cdp/scripts/cdp.mjs nav <target> "http://127.0.0.1:17890/bilibili_tabulabili_try.user.js?update=$(date +%s)"
   ```

4. 不要在 `https://www.tampermonkey.net/script_installation.php#url=...` 中间页等待或找按钮。重新 `list` 找 Tampermonkey 确认页 target:

   ```sh
   node ~/.claude/skills/chrome-cdp/scripts/cdp.mjs list
   ```

   URL 形如 `chrome-extension://dhdgffkkebhmkfjojejmpbldmpobfkfo/ask.html?...`。版本递增时标题通常是
   `Userscript update`;同版本重新安装修复内容时标题是 `Userscript re-installation`。

5. 在 `ask.html` target 点击对应按钮。Update 选择器是 `#input_VXBkYXRlX3VuZGVmaW5lZA_bu`,Reinstall
   选择器是 `#input_UmVpbnN0YWxsX3VuZGVmaW5lZA_bu`。用 `cdp click`,不要用 `eval ...el.click()` —— 后者常报
   "Daemon failed to start"。先根据页面 title 验证对应按钮的 value 和可见性再点:

   ```sh
   node ~/.claude/skills/chrome-cdp/scripts/cdp.mjs eval <ask-target> 'JSON.stringify({updateButton: (() => { const el = document.getElementById("input_VXBkYXRlX3VuZGVmaW5lZA_bu"); return el ? {id: el.id, value: el.value, visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)} : null; })()})'
   node ~/.claude/skills/chrome-cdp/scripts/cdp.mjs click <ask-target> "#input_VXBkYXRlX3VuZGVmaW5lZA_bu"
   node ~/.claude/skills/chrome-cdp/scripts/cdp.mjs eval <ask-target> 'JSON.stringify({title: document.title, reinstallButton: (() => { const el = document.getElementById("input_UmVpbnN0YWxsX3VuZGVmaW5lZA_bu"); return el ? {id: el.id, value: el.value, visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)} : null; })()})'
   node ~/.claude/skills/chrome-cdp/scripts/cdp.mjs click <ask-target> "#input_UmVpbnN0YWxsX3VuZGVmaW5lZA_bu"
   ```

## Validation — 运行版本与事件

用 CDP 打开或刷新 `https://www.bilibili.com/`,读取页面内 `window.__tabulaBiliTry` 验证真实运行版本和事件。打开页面时不应自动触发 `roll-button-click` 或推荐接口请求。

```sh
node ~/.claude/skills/chrome-cdp/scripts/cdp.mjs eval <bilibili-target> 'JSON.stringify((() => { const api = window.__tabulaBiliTry; const logs = api && api.dumpLogs ? api.dumpLogs() : []; return {version: api && api.version, mode: api && api.requestMode && api.requestMode(), clickCount: logs.filter(l => l.event === "roll-button-click").length, readyCount: logs.filter(l => l.event === "roll-button-ready").length, timeoutCount: logs.filter(l => l.event === "roll-button-timeout").length, feedCount: logs.filter(l => l.event === "fetch-target-credentials-omitted").length, events: logs.map(l => l.event)} })(), null, 2)'
```

验收条件:

- `version` 等于当前脚本内 `VERSION`。
- 打开/刷新 B 站首页后 `clickCount` 为 `0`。
- 打开/刷新 B 站首页后 `feedCount` 为 `0`。
- 只出现 `roll-button-ready`,不出现自动 `roll-button-click`。

其它脚本的等价验证:若上报某 video intro URL 不可点,先在 CDP 新开的视频页确认 `window._biliVideoLinkifyRunning`;当前源可能正常,而安装版 Tampermonkey 副本已 stale/未运行。

## 本地产物落点

本地验证服务、日志和临时文件只能放在 workspace 内。常用目录 `logs/`、`.tmp/`、`var/log/` 必须保持在 `.gitignore` 中。诊断证据可放 `logs/`(已 ignore);任何临时 `127.0.0.1:17890` 服务用完关闭,确认无监听残留。

## Constraints

- 只用 CDP 操作 Chrome;不可用时报告阻塞,不绕过。
- 重装前必跑 `node --check`。
- 提交进仓库的样本/日志需脱敏。
