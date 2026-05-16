// ==UserScript==
// @name         Bilibili 大图自定义参数与查看原图
// @namespace    http://tampermonkey.net/
// @version      2026-03-02
// @description  为B站PhotoSwipe大图自动添加缩放参数，并提供查看原图按钮
// @author       GitHub Copilot
// @match        *://*.bilibili.com/*
// @match        *://t.bilibili.com/*
// @match        *://space.bilibili.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // - 0e：等比缩放且**按长边为准**（只要宽或高任一边达到了指定值就会缩放，保证不被截断、不变形，且完整呈现在 480x480 的矩形框内）。
    const TARGET_PARAM = '@900w_900h_0e.webp';

    function modifyImage(img) {
        // 【关键】如果是已被用户点击“原地显示原图”的图片，则不执行缩放参数替换
        if (img.dataset.showOriginal === 'true') return;

        let src = img.getAttribute('src');
        if (!src || !src.includes('hdslb.com')) return;

        // 提取没有 @ 参数后缀的原始基础链接
        const baseUrl = src.split('@')[0];

        // 将原图链接保存到 dataset 中供按钮使用
        if (!img.dataset.originalSrc) {
            img.dataset.originalSrc = baseUrl;
        }

        // 如果图片的 src 末尾还不是目标参数，则替换原 src
        if (!src.endsWith(TARGET_PARAM)) {
            img.setAttribute('src', baseUrl + TARGET_PARAM);
        }
    }

    function addOriginalBtn(topBar) {
        // 防止重复重复添加按钮
        if (document.querySelector('.pswp-custom-ori-btn')) return;

        const btn = document.createElement('button');
        btn.className = 'pswp__button pswp-custom-ori-btn';

        // 替换为"放大镜/高清"类型的图标，契合“原地展开大图”的含义
        btn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line><line x1="11" y1="8" x2="11" y2="14"></line><line x1="8" y1="11" x2="14" y2="11"></line></svg>`;
        btn.title = '显示原图'; // 鼠标悬停时的 tooltip 提示

        // 采用绝对定位并重置内外边距，稍后动态计算坐标与宽高等同关闭按钮
        btn.style.cssText = 'position: absolute; right: 0; top: 44px; color: #fff; background: rgba(0,0,0,0.1); border: none; cursor: pointer; height: 44px; width: 44px; display: flex; align-items: center; justify-content: center; z-index: 99999; opacity: 0.75; transition: all 0.2s; margin: 0; padding: 0;';

        // 增加 Hover 高亮效果
        btn.addEventListener('mouseenter', () => btn.style.opacity = '1');
        btn.addEventListener('mouseleave', () => btn.style.opacity = '0.75');

        // 改为：原地替换大图链接
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            // 寻找 aria-hidden="false" 的当前活动图片容器
            const activeImg = document.querySelector('.pswp__item[aria-hidden="false"] .pswp__img');
            if (activeImg) {
                const originalUrl = activeImg.dataset.originalSrc || activeImg.src.split('@')[0];

                // 标记为展示原图，并原地替换 src，追加 .webp 使原图也转为 webp 格式传输
                activeImg.dataset.showOriginal = 'true';
                activeImg.src = originalUrl + '@.webp';
                activeImg.removeAttribute('srcset');

                // 简单的视觉反馈：图标闪烁为B站蓝，再恢复
                const svg = btn.querySelector('svg');
                if (svg) {
                    svg.style.stroke = '#00a1d6';
                    setTimeout(() => svg.style.stroke = 'currentColor', 500);
                }
            }
        });

        // 插入到顶栏内
        topBar.appendChild(btn);

        // 动态读取自带“关闭按钮”的准确占位，实现完美垂直居中对齐
        const closeBtn = topBar.querySelector('.pswp__button--close');
        if (closeBtn) {
            const alignBtn = () => {
                const cRect = closeBtn.getBoundingClientRect();
                const tRect = topBar.getBoundingClientRect();
                if (cRect.width > 0) {
                    btn.style.right = (tRect.right - cRect.right) + 'px';
                    btn.style.width = cRect.width + 'px';
                    btn.style.top = cRect.height + 'px';
                }
            };
            // Pswp相册弹出时带有过渡动画，多帧校准以保证对齐准确
            alignBtn();
            setTimeout(alignBtn, 50);
            setTimeout(alignBtn, 300);
        }
    }

    // 观察全局 DOM，捕捉点击大图时生成的 PhotoSwipe (pswp) 容器和图片
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            // 监听图片 src 的动态更替 (如左右翻页)
            if (mutation.type === 'attributes' && mutation.attributeName === 'src') {
                if (mutation.target.classList && mutation.target.classList.contains('pswp__img')) {
                    modifyImage(mutation.target);
                }
            }
            // 监听新图层或容器被插入
            else if (mutation.type === 'childList') {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === 1) { // 仅处理 element 节点
                        if (node.classList && node.classList.contains('pswp')) {
                            // 大图容器出现，添加按钮并替换首次渲染的图
                            const topBar = node.querySelector('.pswp__top-bar');
                            if (topBar) addOriginalBtn(topBar);

                            node.querySelectorAll('.pswp__img').forEach(modifyImage);
                        } else if (node.classList && node.classList.contains('pswp__img')) {
                            modifyImage(node);
                        }
                    }
                });
            }
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src']
    });
})();