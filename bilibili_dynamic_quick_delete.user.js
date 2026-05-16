// ==UserScript==
// @name         Bilibili 动态快速删除
// @namespace    http://tampermonkey.net/
// @version      2025-12-07
// @description  快速删除Bilibili动态，一键清理抽奖动态，支持自动取关
// @author       mi
// @match        https://space.bilibili.com/*/dynamic
// @icon         https://www.google.com/s2/favicons?sz=64&domain=bilibili.com
// @grant        GM_getValue
// @grant        GM_setValue
// @license      MIT
// ==/UserScript==

(async function () {
    "use strict";
    let whitelists = GM_getValue("whitelists");
    if (!whitelists || !Array.isArray(whitelists)) {
        whitelists = ["example"];
        GM_setValue("whitelists", whitelists);
    }

    async function wait(ms) {
        return new Promise((resolve) => {
            setTimeout(() => {
                resolve();
            }, ms);
        });
    }
    /**
     * @param {HTMLElement} moreEl
     */
    async function deleteDyn(moreEl) {
        ["mouseenter", "mouseover", "pointerenter", "pointerover"].forEach(
            (type) => {
                moreEl
                    .querySelector(".tp.bili-dyn-more__btn")
                    .dispatchEvent(
                        new MouseEvent(type, { bubbles: true, cancelable: true })
                    );
            }
        );

        await wait(100);

        const items = moreEl.querySelectorAll(".bili-cascader-options__item");

        const deleteBtn = [...items].filter(el => el.textContent.trim() == "删除")[0];
        deleteBtn.click();
        await wait(200);
        document.querySelector(".bili-modal__button.confirm").click();
        await wait(200);
    }

    /**
     * @param {HTMLElement} moreEl
     */
    async function unfollow(moreEl) {
        const referenceEl = moreEl
            .closest(".bili-dyn-item__main")
            .querySelector(
                ".bili-dyn-content__orig.reference > div .dyn-orig-author__name"
            );
        if (!referenceEl) return;
        const userName = referenceEl.textContent.trim();
        if (!userName) return;
        if (whitelists.includes(userName)) {
            console.log("!!!!!Bilibili whitelisted", userName);
            return;
        }
        ["mouseenter", "mouseover", "pointerenter", "pointerover"].forEach(
            (type) => {
                referenceEl.dispatchEvent(
                    new MouseEvent(type, { bubbles: true, cancelable: true })
                );
            }
        );
        /**
         * @type {HTMLElement}
         */
        let infoEl = null;
        let infoName = "";
        while (infoEl == null || userName !== infoName) {
            await wait(100);
            infoEl = document.querySelector(".bili-user-profile-view__info");
            infoName = infoEl
                ?.querySelector(".bili-user-profile-view__info__header > a")
                ?.textContent?.trim();
        }

        const followBtn = infoEl.querySelector(
            ".bili-user-profile-view__info__button.follow.checked"
        );
        if (!followBtn) {
            return;
        }
        console.log("!!!!!Bilibili unfollowed", userName);
        await wait(100);
        followBtn.click();
        await wait(100);
    }
    async function deleteAllLottery() {
        while (document.querySelector(".bili-dyn-list-no-more") == null) {
            window.scrollBy(0, 1000000);
            await wait(10);
        }

        document.querySelectorAll(".bili-rich-text__action").forEach((el) => {
            if (el.textContent === "展开") {
                el.click();
            }
        });

        async function closeDetail() {
            return new Promise(async (resolve) => {
                function _button() {
                    return document.querySelector(".bili-popup__header__close");
                }
                _button().click();
                while (_button() != null) {
                    await wait(100);
                }
                resolve();
            });
        }
        /**
         * @type {Set<string>}
         */
        const skipUnfollow = new Set();
        for (const item of document.querySelectorAll(
            ".opus-text-rich-hl.lottery"
        )) {
            item.click();
            await wait(100);
            const mainEl = item.closest(".bili-dyn-item__main");
            const name = mainEl
                .querySelector(
                    ".bili-dyn-content__orig.reference > div .dyn-orig-author__name"
                )
                .textContent.trim();
            if (name == null) {
                await closeDetail();
                continue;
            }
            await wait(100);

            /**
             * @type {HTMLIFrameElement}
             */
            const lotteryIframe = document.querySelector(
                ".bili-popup__content > iframe"
            );
            // https://www.bilibili.com/h5/lottery/result?business_type=1&business_id=1050373572691755026&isWeb=1
            const lotteryBusinessId =
                lotteryIframe.src.match("business_id=(\\d+)")[1];
            const lotteryDetailSrc = `https://api.vc.bilibili.com/lottery_svr/v1/lottery_svr/lottery_notice?business_id=${lotteryBusinessId}&business_type=1`;
            const lotteryDetail = await (await fetch(lotteryDetailSrc)).json();
            const lotteryResult = lotteryDetail["data"]["lottery_result"];
            await closeDetail();
            // incomplete
            if (lotteryResult == null) {
                skipUnfollow.add(name);
                continue;
            }
            const moreEl = mainEl.querySelector(".bili-dyn-item__more");
            if (moreEl == null) {
                continue;
            }

            if (!skipUnfollow.has(name)) {
                await unfollow(moreEl);
                await deleteDyn(moreEl);
            } else {
                await deleteDyn(moreEl);
            }
        }
    }
    function enhanceDynItem(moreEl) {
        if (moreEl._hasDynMoreEnhance) return;
        moreEl._hasDynMoreEnhance = true;

        const quickDeleteEl = document.createElement("div");
        quickDeleteEl.className =
            "bili-cascader-options__item bili-cascader-options__item-custom bili-cascader-options__item-label";
        quickDeleteEl.innerText = "快速删除";
        moreEl.appendChild(quickDeleteEl);

        const quickUnfollowEl = quickDeleteEl.cloneNode(true);
        quickUnfollowEl.innerText = "快速删除 & 取关";
        moreEl.appendChild(quickUnfollowEl);

        quickDeleteEl.addEventListener("click", function (e) {
            e.stopPropagation();
            deleteDyn(moreEl);
        });

        quickUnfollowEl.addEventListener("click", async function (e) {
            e.stopPropagation();
            await unfollow(moreEl);
            await deleteDyn(moreEl);
        });
    }

    // 监听全局新增
    const obs = new MutationObserver((records) => {
        for (const rec of records) {
            for (const node of rec.addedNodes) {
                if (!(node instanceof HTMLElement)) continue;
                // 新增就是 .bili-dyn-item__more
                if (!node.matches(".bili-dyn-list__item")) {
                    continue;
                }

                const moreEl = node.querySelector(".bili-dyn-item__more");
                if (moreEl) {
                    enhanceDynItem(moreEl);
                }
            }
        }
    });

    while (document.body == null) {
        await wait(100);
    }
    obs.observe(document.body, { childList: true, subtree: true });

    /**
     * @type {HTMLElement}
     */
    let nav = null;
    while (nav == null) {
        await wait(100);
        nav = document.querySelector(".side-nav");
    }
    const deleteAllLotteryBtn = document.createElement("div");
    deleteAllLotteryBtn.className = "side-nav__item";
    nav.appendChild(deleteAllLotteryBtn);
    deleteAllLotteryBtn.innerText = "删除所有抽奖";

    deleteAllLotteryBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        deleteAllLottery();
    });
})();
