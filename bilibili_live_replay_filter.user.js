// ==UserScript==
// @name         NO 直播回放
// @namespace    http://tampermonkey.net/
// @version      2025-01-12
// @description  Remove 直播回放
// @author       You
// @match        https://t.bilibili.com/
// @icon         https://www.google.com/s2/favicons?sz=64&domain=bilibili.com
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  [...document.querySelectorAll(".bili-dyn-card-video__badge")]
    .filter((el) => el.textContent === "直播回放")
    .map((el) => el.closest(".bili-dyn-list__item"))
    .forEach((el) => el.remove());
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === 1) {
          const el = node.querySelector(".bili-dyn-card-video__badge");
          if (el && el.textContent === "直播回放") {
            node.remove();
          }
        }
      });
    });
  });
  observer.observe(document.querySelector(".bili-dyn-list"), {
    childList: true,
    subtree: true,
  });

  // Your code here...
})();
