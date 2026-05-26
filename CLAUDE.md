# Workspace Instructions

## 额外遵循的外部规则

本项目遵循以下规则文件,等同于把其正文内容并入本项目 CLAUDE.md:

@~/.aiGlobal/rules-optional/commit-after-task.md
@~/.aiGlobal/rules-optional/local-detailed-logging.md

## Chrome 验证

操作用户当前 Chrome 只能使用 CDP。禁止使用 AppleScript、GUI 键盘鼠标、截图、剪贴板或临时 Chrome profile 来更新脚本或验证页面行为。CDP 不可用时先停下说明阻塞,不要换其它方式绕过。

CDP 工具路径:

```sh
node ~/.claude/skills/chrome-cdp/scripts/cdp.mjs list
```

## Tampermonkey 更新流程

更新 `bilibili_tabulabili_try.user.js` 后,用 CDP 完成 Tampermonkey 安装版更新与验证。

1. 启动一个 workspace 内的本地验证服务,服务当前 `bilibili_tabulabili_try.user.js`,并可选接收 `/tabulabili-log` 日志。服务结束后必须关闭,确认 `127.0.0.1:17890` 无监听残留。
2. 用 CDP 打开本地 userscript URL,触发 Tampermonkey 更新页:

```sh
node ~/.claude/skills/chrome-cdp/scripts/cdp.mjs nav <target> "http://127.0.0.1:17890/bilibili_tabulabili_try.user.js?update=$(date +%s)"
```

3. 不要在 `https://www.tampermonkey.net/script_installation.php#url=...` 中间页等待或查找按钮。重新 `list` 找到 Tampermonkey 扩展确认页 target:

```sh
node ~/.claude/skills/chrome-cdp/scripts/cdp.mjs list
```

目标页面标题通常是 `Userscript update`,URL 形如 `chrome-extension://dhdgffkkebhmkfjojejmpbldmpobfkfo/ask.html?...`。

4. 在 `ask.html` target 里点击 Update 按钮。当前按钮选择器是:

```js
#input_VXBkYXRlX3VuZGVmaW5lZA_bu
```

CDP 验证按钮并点击:

```sh
node ~/.claude/skills/chrome-cdp/scripts/cdp.mjs eval <ask-target> 'JSON.stringify({updateButton: (() => { const el = document.getElementById("input_VXBkYXRlX3VuZGVmaW5lZA_bu"); return el ? {id: el.id, value: el.value, visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)} : null; })()})'
node ~/.claude/skills/chrome-cdp/scripts/cdp.mjs eval <ask-target> '(() => { const el = document.getElementById("input_VXBkYXRlX3VuZGVmaW5lZA_bu"); if (el === null) return "missing"; el.click(); return "clicked:" + el.value; })()'
```

5. 用 CDP 打开或刷新 `https://www.bilibili.com/`,读取页面内 `window.__tabulaBiliTry` 验证真实运行版本和事件。打开页面时不应自动触发 `roll-button-click` 或推荐接口请求。

```sh
node ~/.claude/skills/chrome-cdp/scripts/cdp.mjs eval <bilibili-target> 'JSON.stringify((() => { const api = window.__tabulaBiliTry; const logs = api && api.dumpLogs ? api.dumpLogs() : []; return {version: api && api.version, mode: api && api.requestMode && api.requestMode(), clickCount: logs.filter(l => l.event === "roll-button-click").length, readyCount: logs.filter(l => l.event === "roll-button-ready").length, timeoutCount: logs.filter(l => l.event === "roll-button-timeout").length, feedCount: logs.filter(l => l.event === "fetch-target-credentials-omitted").length, events: logs.map(l => l.event)} })(), null, 2)'
```

验收条件:

- `version` 等于当前脚本内 `VERSION`。
- 打开/刷新 B 站首页后 `clickCount` 为 `0`。
- 打开/刷新 B 站首页后 `feedCount` 为 `0`。
- 只出现 `roll-button-ready`,不出现自动 `roll-button-click`。

## 本地产物

本地验证服务、日志和临时文件只能放在 workspace 内。常用目录包括 `logs/`、`.tmp/` 和 `var/log/`,这些路径必须保持在 `.gitignore` 中。
