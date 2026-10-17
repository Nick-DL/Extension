/*!
 * bridge.js — 同源驱动内嵌的「光学传输」核心（core/send.html）
 * ---------------------------------------------------------------------------
 * 核心来自 Decimen Optical Transfer v0.5.3（AGPL-3.0-or-later），保持上游行为不变，
 * 本文件只负责：
 *   · 把截图 File 塞进核心的 <input type=file>；
 *   · 向核心的帧率 / 每帧字节 / 码数 / 纠错下拉框写入设置；
 *   · 读取核心的状态文字与分享二维码画布。
 *
 * 该桥接只在同源（chrome-extension:// 内部）时可用；排班插件里始终满足。
 */
(function () {
  'use strict';

  var OFT = (window.OFT = window.OFT || {});

  function createBridge(options) {
    var frame = options.frame;
    var src = options.src;
    var css = options.css || '';
    var readySelector = options.readySelector || 'body';
    var styleId = 'oft-bridge-style';

    var loaded = false;
    var loadWaiters = [];
    var readyHandlers = [];

    function doc() {
      if (!frame) return null;
      try {
        var d = frame.contentDocument;
        return d && d.documentElement ? d : null;
      } catch (error) { return null; }
    }

    function win() {
      try { return frame.contentWindow; } catch (error) { return null; }
    }

    function available() { return !!doc(); }

    function find(selector) {
      var d = doc();
      return d ? d.querySelector(selector) : null;
    }

    function findAll(selector) {
      var d = doc();
      return d ? Array.prototype.slice.call(d.querySelectorAll(selector)) : [];
    }

    function injectCss() {
      var d = doc();
      if (!d || !css) return;
      var existing = d.getElementById(styleId);
      if (existing) existing.remove();
      var style = d.createElement('style');
      style.id = styleId;
      style.textContent = css;
      (d.head || d.documentElement).appendChild(style);
    }

    function dispatchResize() {
      var w = win();
      if (!w) return;
      try { w.dispatchEvent(new w.Event('resize')); } catch (error) { /* 忽略 */ }
    }

    function fireReady() {
      injectCss();
      dispatchResize();
      readyHandlers.slice().forEach(function (handler) {
        try { handler(); } catch (error) { /* 忽略 */ }
      });
    }

    frame.addEventListener('load', function () {
      if (!frame.getAttribute('src')) return;
      loaded = true;
      var waiters = loadWaiters;
      loadWaiters = [];
      if (doc()) fireReady();
      waiters.forEach(function (resolve) { resolve(); });
    });

    function whenLoaded() {
      if (loaded) return Promise.resolve();
      return new Promise(function (resolve) { loadWaiters.push(resolve); });
    }

    function ensureReady() {
      var started = Date.now();
      return new Promise(function (resolve, reject) {
        (function tick() {
          if (!frame.isConnected) { reject(new Error('核心页面被移除')); return; }
          var d = doc();
          if (d && d.readyState !== 'loading' && d.querySelector(readySelector)) { resolve(); return; }
          if (Date.now() - started > 15000) { reject(new Error('核心页面加载超时')); return; }
          window.setTimeout(tick, 100);
        })();
      });
    }

    /** 载入核心页（只导航一次）并等它就绪 */
    function load() {
      if (!frame.getAttribute('src')) frame.setAttribute('src', src);
      return whenLoaded().then(ensureReady).then(function () { loaded = true; });
    }

    /** 重新载入核心页：换截图后必须重载，否则核心还在画上一张图 */
    function reload() {
      loaded = false;
      injectCss();
      var d = doc();
      if (d) {
        try {
          d.location.reload();
          return whenLoaded().then(ensureReady);
        } catch (error) { /* 落到下面 */ }
      }
      frame.setAttribute('src', 'about:blank');
      return new Promise(function (resolve) {
        window.setTimeout(function () {
          frame.setAttribute('src', src);
          resolve(whenLoaded().then(ensureReady));
        }, 30);
      });
    }

    /** 每次核心页加载/重载完成后回调一次 */
    function onReady(handler) {
      if (typeof handler !== 'function') return function () {};
      readyHandlers.push(handler);
      return function () {
        var index = readyHandlers.indexOf(handler);
        if (index >= 0) readyHandlers.splice(index, 1);
      };
    }

    function text(selector) {
      var node = find(selector);
      return node ? (node.textContent || '').trim() : '';
    }

    function click(selector) {
      var node = find(selector);
      if (!node) return false;
      try { node.click(); return true; } catch (error) { return false; }
    }

    /** 把 File 塞进核心的 <input type=file> 并派发 change（同源下允许） */
    function setFiles(selector, files) {
      var input = find(selector);
      var w = win();
      if (!input || !w || !w.DataTransfer) return false;
      try {
        var transfer = new w.DataTransfer();
        files.forEach(function (file) { transfer.items.add(file); });
        input.files = transfer.files;
        input.dispatchEvent(new w.Event('change', { bubbles: true }));
        return true;
      } catch (error) { return false; }
    }

    function setValue(selector, value) {
      var node = find(selector);
      var w = win();
      if (!node || !w) return false;
      try {
        node.value = value;
        node.dispatchEvent(new w.Event('input', { bubbles: true }));
        node.dispatchEvent(new w.Event('change', { bubbles: true }));
        return true;
      } catch (error) { return false; }
    }

    /** 观察核心页里的某个节点，返回停止函数 */
    function observe(selector, handler) {
      var d = doc();
      var w = win();
      if (!d || !w || !w.MutationObserver) return function () {};
      var target = d.querySelector(selector);
      if (!target) return function () {};
      var observer = new w.MutationObserver(function () { handler(); });
      observer.observe(target, { childList: true, subtree: true, attributes: true, characterData: true });
      return function () { observer.disconnect(); };
    }

    function canvasDataUrl(selector) {
      var node = find(selector);
      if (!node || typeof node.toDataURL !== 'function') return '';
      try { return node.toDataURL('image/png'); } catch (error) { return ''; }
    }

    function wait(ms) {
      return new Promise(function (resolve) { window.setTimeout(resolve, ms); });
    }

    /** 轮询直到条件成立 */
    function waitUntil(check, timeout, interval) {
      var limit = timeout === undefined ? 8000 : timeout;
      var step = interval || 120;
      var started = Date.now();
      return new Promise(function (resolve, reject) {
        (function tick() {
          var value;
          try { value = check(); } catch (error) { value = false; }
          if (value) { resolve(value); return; }
          if (Date.now() - started > limit) { reject(new Error('等待条件超时')); return; }
          window.setTimeout(tick, step);
        })();
      });
    }

    return {
      frame: frame,
      load: load,
      reload: reload,
      onReady: onReady,
      available: available,
      doc: doc,
      win: win,
      find: find,
      findAll: findAll,
      text: text,
      click: click,
      setFiles: setFiles,
      setValue: setValue,
      observe: observe,
      canvasDataUrl: canvasDataUrl,
      wait: wait,
      waitUntil: waitUntil,
      injectCss: injectCss,
      dispatchResize: dispatchResize
    };
  }

  /* 隐藏核心页自带的页头 / 页脚 / 表单，只留下二维码舞台 */
  var SEND_CSS = [
    'html{height:100% !important}',
    'html,body{background:#fff !important}',
    'body{padding:0 !important;margin:0 !important;display:block !important;gap:0 !important;',
    'min-height:0 !important;height:100% !important;overflow:hidden !important}',
    '.site-header,.site-footer,.tool-intro,.mode-picker,.file-picker,.demo-picker,.note-composer,',
    'details.settings,#specs,#footer-hint,.optical-standalone-back-wrap,.optical-standalone-note{display:none !important}',
    '.send-shell{display:block !important;width:100% !important;height:100% !important;margin:0 !important;padding:0 !important}',
    '#stage{display:flex !important;align-items:center !important;justify-content:center !important;',
    'width:100% !important;height:100% !important;margin:0 !important;padding:12px !important;border-radius:0 !important;',
    'background:#fff !important;cursor:default !important;box-shadow:none !important}',
    '#stage[hidden]{display:none !important}',
    '#qr{max-width:100% !important;max-height:100% !important}',
    'dialog{display:none !important}'
  ].join('');

  OFT.bridge = {
    create: createBridge,
    sendCss: SEND_CSS
  };
})();
