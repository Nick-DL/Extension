/*!
 * send.js — 截图传输发送页（三步向导）
 *   1. 在排班页面截取 ant 表格 → 预览；
 *   2. 固定接收页地址 + 二维码；
 *   3. 用核心页展示动态二维码。
 * 传输能力由 core/send.html（Decimen Optical Transfer v0.5.3，AGPL-3.0-or-later）完成。
 */
(function () {
  'use strict';

  var OFT = (window.OFT = window.OFT || {});
  var RECEIVE_URL = 'https://oft.nickdl.site/receive.html';
  var SETTINGS_KEY = 'sh.optical.send.settings';
  var DEFAULTS = { fps: '30', bytes: '2953', grid: '1', ecc: 'L' };
  var SETTING_SELECTORS = { fps: '#cfg-fps', bytes: '#cfg-bytes', grid: '#cfg-grid', ecc: '#cfg-ecc' };
  var SETTING_VALUES = {
    fps: ['10', '15', '20', '24', '30', '55', '60'],
    bytes: ['500', '1000', '1465', '1850', '2331', '2953'],
    grid: ['1', '2', '4', '6'],
    ecc: ['L', 'M', 'Q', 'H']
  };

  var state = {
    step: 1,
    sourceTabId: null,
    sourceTab: null,
    screenshot: null,
    capturing: false,
    streamStarted: false,
    streamError: '',
    linkQr: '',
    settings: assign({}, DEFAULTS),
    myWindowId: null,
    coreReloading: null,
    preparePromise: null,
    bridge: null,
    statusObserver: null
  };

  var el = {};

  function assign(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src) continue;
      Object.keys(src).forEach(function (key) { target[key] = src[key]; });
    }
    return target;
  }

  function $(id) { return document.getElementById(id); }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function formatBytes(bytes) {
    if (!bytes && bytes !== 0) return '—';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  }
  function formatTime(ts) {
    var d = new Date(ts || Date.now());
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function sleep(ms) { return new Promise(function (r) { window.setTimeout(r, ms); }); }

  /* ==================== 初始化 ==================== */
  document.addEventListener('DOMContentLoaded', init);

  function init() {
    el = {
      targetTitle: $('target-title'),
      targetUrl: $('target-url'),
      empty: $('preview-empty'),
      previewWrap: $('preview-wrap'),
      previewImg: $('preview-img'),
      previewInfo: $('preview-info'),
      step1Error: $('step1-error'),
      captureStatus: $('capture-status'),
      btnCapture: $('btn-capture'),
      btnRecapture: $('btn-recapture'),
      toStep2: $('to-step2'),
      toStep1: $('to-step1'),
      toStep3: $('to-step3'),
      toStep2b: $('to-step2b'),
      btnRestart: $('btn-restart'),
      btnClose: $('btn-close'),
      stepSections: Array.prototype.slice.call(document.querySelectorAll('.step-panel')),
      stepItems: Array.prototype.slice.call(document.querySelectorAll('#stepper li')),
      linkQr: $('link-qr'),
      linkQrPlaceholder: $('link-qr-placeholder'),
      linkQrTip: $('link-qr-tip'),
      fileChip: $('file-chip'),
      transferFile: $('transfer-file'),
      stageCover: $('stage-cover'),
      stageCoverText: $('stage-cover-text'),
      transferStatus: $('transfer-status'),
      statusDot: $('status-dot'),
      toast: $('toast'),
      settings: Array.prototype.slice.call(document.querySelectorAll('.settings-grid select')),
      frame: $('core-frame')
    };

    loadSettings();
    bindEvents();
    initBridge();
    initWindowAndTarget();
    setStep(1);
  }

  function loadSettings() {
    try {
      var raw = window.localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        Object.keys(DEFAULTS).forEach(function (key) {
          var value = parsed && parsed[key];
          if (value !== undefined && SETTING_VALUES[key].indexOf(String(value)) >= 0) {
            state.settings[key] = String(value);
          }
        });
      }
    } catch (error) { /* 忽略 */ }
    el.settings.forEach(function (select) {
      var key = select.getAttribute('data-key');
      if (key && state.settings[key]) select.value = state.settings[key];
    });
  }

  function saveSettings() {
    try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch (error) { /* 忽略 */ }
  }

  function bindEvents() {
    el.btnCapture.addEventListener('click', startCapture);
    el.btnRecapture.addEventListener('click', startCapture);
    el.toStep2.addEventListener('click', goStep2);
    el.toStep1.addEventListener('click', function () { setStep(1); });
    el.toStep3.addEventListener('click', function () { setStep(3); });
    el.toStep2b.addEventListener('click', function () { setStep(2); });
    el.btnRestart.addEventListener('click', restart);
    el.btnClose.addEventListener('click', closeWindow);

    el.settings.forEach(function (select) {
      select.addEventListener('change', function () {
        var key = select.getAttribute('data-key');
        if (!key) return;
        state.settings[key] = select.value;
        saveSettings();
        applySettingsToCore();
        if (state.streamStarted) {
          setTransferStatus('设置已更新，正在重新开始发送…', 'busy');
          window.setTimeout(mirrorCoreStatus, 700);
        }
      });
    });

    chrome.runtime.onMessage.addListener(function (message) {
      if (!message || message.type !== 'TRANSFER_SET_SOURCE') return;
      var next = Number(message.sourceTabId) || null;
      if (!next || next === state.sourceTabId) return;
      state.sourceTabId = next;
      resetForNewSource();
      refreshTargetInfo();
      showToast('目标页面已切换，请重新截屏');
    });

    window.addEventListener('beforeunload', function () {
      if (state.screenshot && state.screenshot.url) {
        try { URL.revokeObjectURL(state.screenshot.url); } catch (error) { /* 忽略 */ }
      }
      // 窗口在截屏途中被关掉时，让排班页面恢复原状
      if (state.sourceTabId) {
        try {
          chrome.tabs.sendMessage(state.sourceTabId, { type: 'SH_SHOT_END' }, function () {
            void chrome.runtime.lastError;
          });
        } catch (error) { /* 忽略 */ }
      }
    });
  }

  function initBridge() {
    if (!OFT.bridge || !OFT.bridge.create) {
      showToast('传输核心脚本加载失败', true);
      return;
    }
    state.bridge = OFT.bridge.create({
      frame: el.frame,
      src: './core/send.html',
      css: OFT.bridge.sendCss,
      readySelector: '#cfg-file'
    });
    state.bridge.onReady(function () {
      applySettingsToCore();
      mirrorCoreStatus();
      if (state.statusObserver) { try { state.statusObserver(); } catch (error) { /* 忽略 */ } }
      state.statusObserver = state.bridge.observe('#specs', mirrorCoreStatus);
      state.bridge.dispatchResize();
    });
    // 提前载入核心，进入第 2 步时不用再等
    state.bridge.load().catch(function () { /* 静默：真正需要时会再报错 */ });
  }

  function initWindowAndTarget() {
    var params = new URLSearchParams(window.location.search);
    var fromUrl = Number(params.get('tab')) || null;
    if (fromUrl) state.sourceTabId = fromUrl;

    chrome.windows.getCurrent(function (win) {
      if (!chrome.runtime.lastError && win) state.myWindowId = win.id;
      chrome.runtime.sendMessage({ type: 'GET_TRANSFER_TARGET', windowId: state.myWindowId }, function (response) {
        if (chrome.runtime.lastError) { /* 忽略 */ }
        if (response && response.success && response.sourceTabId) {
          state.sourceTabId = response.sourceTabId;
        }
        refreshTargetInfo();
      });
    });
  }

  function refreshTargetInfo() {
    if (!state.sourceTabId) {
      el.targetTitle.textContent = '未指定目标页面';
      el.targetUrl.textContent = '请从排班页面的「截图传输」入口重新打开';
      return;
    }
    chrome.tabs.get(state.sourceTabId, function (tab) {
      if (chrome.runtime.lastError || !tab) {
        el.targetTitle.textContent = '目标页面已关闭';
        el.targetUrl.textContent = '请从排班页面的「截图传输」入口重新打开';
        return;
      }
      state.sourceTab = tab;
      el.targetTitle.textContent = tab.title || '排班页面';
      el.targetUrl.textContent = tab.url || '';
    });
  }

  /* ==================== 步骤切换 ==================== */
  function setStep(step) {
    state.step = step;
    el.stepSections.forEach(function (section) {
      var active = Number(section.getAttribute('data-step')) === step;
      section.classList.toggle('active', active);
      section.hidden = !active;
    });
    el.stepItems.forEach(function (item) {
      var n = Number(item.getAttribute('data-step'));
      item.classList.toggle('active', n === step);
      item.classList.toggle('done', n < step);
    });
    window.scrollTo({ top: 0, behavior: 'auto' });
    if (step === 2) enterStep2();
    if (step === 3) enterStep3();
  }

  /* ==================== 截屏 ==================== */
  function startCapture() {
    if (state.capturing) return;
    if (!state.sourceTabId) {
      showStep1Error('没有指定要截图的排班页面，请关闭窗口后从排班页面重新打开');
      return;
    }
    if (!OFT.capture || typeof OFT.capture.captureScheduleTable !== 'function') {
      showStep1Error('截屏模块加载失败，请关闭窗口后重试');
      return;
    }
    state.capturing = true;
    updateCaptureButtons(true);
    hideStep1Error();
    setCaptureStatus('正在准备截屏…');
    el.toStep2.disabled = true;

    var title = '';
    OFT.capture.captureScheduleTable({
      sourceTabId: state.sourceTabId,
      onProgress: function (done, total) {
        if (done >= total) setCaptureStatus('正在合成图片…');
        else setCaptureStatus('正在截取表格 ' + done + '/' + total + '…');
      }
    }).then(function (result) {
      title = OFT.capture.buildTitle(result.plan.meta);
      return OFT.capture.compose(result.plan, result.shots, {
        title: title,
        timestamp: Date.now()
      });
    }).then(function (shot) {
      if (state.screenshot && state.screenshot.url) {
        try { URL.revokeObjectURL(state.screenshot.url); } catch (error) { /* 忽略 */ }
      }
      state.screenshot = shot;
      state.streamError = '';
      invalidateStream();
      renderScreenshot(shot);
      setCaptureStatus('截图完成 · 可以进入下一步');
      el.toStep2.disabled = false;
      if (state.step !== 1) setStep(1);
    }).catch(function (error) {
      var message = error && error.message ? error.message : String(error);
      showStep1Error(message);
      setCaptureStatus('截图失败', true);
    }).then(function () {
      state.capturing = false;
      updateCaptureButtons(false);
      if (state.screenshot) el.toStep2.disabled = false;
      refreshTargetInfo();
    });
  }

  function updateCaptureButtons(busy) {
    el.btnCapture.disabled = busy;
    el.btnRecapture.disabled = busy;
    el.btnCapture.classList.toggle('loading', busy);
    if (busy) {
      el.btnCapture.dataset.label = el.btnCapture.innerHTML;
      el.btnCapture.innerHTML = '<span class="material-icons">hourglass_top</span> 正在截屏…';
    } else if (el.btnCapture.dataset.label) {
      el.btnCapture.innerHTML = el.btnCapture.dataset.label;
      delete el.btnCapture.dataset.label;
    }
  }

  function renderScreenshot(shot) {
    el.previewImg.src = shot.url;
    el.previewWrap.hidden = false;
    el.empty.hidden = true;
    el.previewInfo.textContent = shot.width + ' × ' + shot.height + ' px · ' + formatBytes(shot.blob.size) + ' · ' + shot.title;
    var chip = '<span class="material-icons">image</span>' + escapeHtml(shot.file.name) + ' · ' + formatBytes(shot.blob.size);
    el.fileChip.innerHTML = chip;
    el.transferFile.innerHTML = chip;
  }

  function setCaptureStatus(text, isError) {
    el.captureStatus.textContent = text || '';
    el.captureStatus.classList.toggle('error', !!isError);
  }

  function showStep1Error(message) {
    el.step1Error.textContent = message;
    el.step1Error.hidden = false;
  }
  function hideStep1Error() { el.step1Error.hidden = true; el.step1Error.textContent = ''; }

  function invalidateStream() {
    var wasStreaming = state.streamStarted;
    state.streamStarted = false;
    state.streamError = '';
    state.linkQr = '';
    resetLinkQrUi();
    if (state.step === 3) setStep(1);
    if (wasStreaming && state.bridge) {
      state.coreReloading = state.bridge.reload().catch(function (error) {
        state.coreReloading = null;
        throw error;
      });
      // 避免未处理的 rejection 影响页面
      state.coreReloading.catch(function () {});
    } else {
      state.coreReloading = Promise.resolve();
    }
  }

  function resetLinkQrUi() {
    if (!el.linkQr) return;
    el.linkQr.hidden = true;
    el.linkQr.removeAttribute('src');
    el.linkQrPlaceholder.hidden = false;
    if (el.linkQrTip) el.linkQrTip.textContent = '正在生成二维码…';
  }

  /* ==================== 第 2 步 ==================== */
  function goStep2() {
    if (!state.screenshot) { showToast('请先截取排班表'); return; }
    hideStep1Error();
    setStep(2);
    el.toStep3.disabled = true;
    prepareAndShowLink().then(function () {
      el.toStep3.disabled = false;
    }).catch(function (error) {
      el.toStep3.disabled = true;
      var message = error && error.message ? error.message : String(error);
      showToast('启动传输失败：' + message, true);
      el.linkQrTip.textContent = '传输核心启动失败，接收页仍可手动打开';
    });
  }

  function enterStep2() {
    if (!state.screenshot) { setStep(1); return; }
    el.fileChip.innerHTML = '<span class="material-icons">image</span>' + escapeHtml(state.screenshot.file.name) + ' · ' + formatBytes(state.screenshot.blob.size);
    if (state.linkQr && el.linkQr.src) {
      el.linkQrPlaceholder.hidden = true;
      el.linkQr.hidden = false;
    } else {
      resetLinkQrUi();
      prepareAndShowLink().catch(function (error) {
        el.toStep3.disabled = true;
        var message = error && error.message ? error.message : String(error);
        el.linkQrTip.textContent = '二维码生成失败，请手动输入上方地址';
        showToast('启动传输失败：' + message, true);
      });
    }
  }

  function prepareAndShowLink() {
    if (state.preparePromise) return state.preparePromise;
    state.preparePromise = doPrepareAndShowLink().then(function (value) {
      state.preparePromise = null;
      return value;
    }, function (error) {
      state.preparePromise = null;
      throw error;
    });
    return state.preparePromise;
  }

  function doPrepareAndShowLink() {
    return prepareStream().then(function () {
      return buildLinkQr();
    }).then(function (dataUrl) {
      state.linkQr = dataUrl || '';
      if (dataUrl) {
        el.linkQr.src = dataUrl;
        el.linkQr.hidden = false;
        el.linkQrPlaceholder.hidden = true;
      } else {
        el.linkQrTip.textContent = '二维码生成失败，请手动输入上方地址';
      }
      return dataUrl;
    });
  }

  function prepareStream() {
    if (!state.screenshot) return Promise.reject(new Error('还没有截图'));
    if (state.streamStarted) return Promise.resolve(true);
    var bridge = state.bridge;
    if (!bridge) return Promise.reject(new Error('传输核心未加载'));
    var ready = state.coreReloading || Promise.resolve();
    return ready.then(function () {
      return bridge.load();
    }).then(function () {
      applySettingsToCore();
      var pushed = bridge.setFiles('#cfg-file', [state.screenshot.file]);
      if (!pushed) throw new Error('无法把截图交给传输核心');
      return waitForStream();
    }).then(function () {
      state.streamStarted = true;
      state.streamError = '';
      return true;
    });
  }

  function waitForStream() {
    var bridge = state.bridge;
    var startedAt = Date.now();
    return new Promise(function (resolve, reject) {
      function tick() {
        if (!bridge.available()) {
          if (Date.now() - startedAt > 20000) { reject(new Error('传输核心加载超时')); return; }
          window.setTimeout(tick, 160);
          return;
        }
        var stage = bridge.find('#stage');
        if (stage && !stage.hidden) { resolve(true); return; }
        var specs = bridge.find('#specs');
        var text = specs ? (specs.textContent || '').trim() : '';
        if (specs && specs.classList.contains('error') && text) {
          reject(new Error(text.replace(/^⚠\s*/, '')));
          return;
        }
        if (Date.now() - startedAt > 25000) {
          reject(new Error(text || '启动传输超时'));
          return;
        }
        window.setTimeout(tick, 150);
      }
      tick();
    });
  }

  function buildLinkQr() {
    if (state.linkQr) return Promise.resolve(state.linkQr);
    var bridge = state.bridge;
    if (!bridge || !bridge.available()) return Promise.resolve('');
    return bridge.waitUntil(function () {
      return bridge.findAll('#specs button').some(function (button) {
        return (button.className || '').indexOf('text-button') >= 0;
      });
    }, 12000, 150).then(function () {
      var input = bridge.find('#share-url');
      if (input) input.value = RECEIVE_URL;
      var buttons = bridge.findAll('#specs button');
      var share = buttons.filter(function (button) {
        return (button.className || '').indexOf('text-button') >= 0;
      })[0] || buttons[0];
      if (!share) return '';
      try { share.click(); } catch (error) { /* 忽略 */ }
      var dataUrl = '';
      return bridge.waitUntil(function () {
        var value = bridge.canvasDataUrl('#share-qr');
        if (value && value.length > 400) { dataUrl = value; return true; }
        return false;
      }, 8000, 120).then(function () {
        bridge.click('#share-close');
        return dataUrl;
      }, function () {
        bridge.click('#share-close');
        return '';
      });
    }, function () {
      return '';
    });
  }

  /* ==================== 第 3 步 ==================== */
  function enterStep3() {
    if (!state.screenshot) { setStep(1); return; }
    el.transferFile.innerHTML = '<span class="material-icons">image</span>' + escapeHtml(state.screenshot.file.name) + ' · ' + formatBytes(state.screenshot.blob.size);
    setTransferStatus('正在准备二维码…', 'busy');
    el.stageCover.hidden = false;
    el.stageCoverText.textContent = '正在准备二维码…';

    prepareStream().then(function () {
      var bridge = state.bridge;
      var startedAt = Date.now();
      return new Promise(function (resolve, reject) {
        function tick() {
          if (!bridge || !bridge.available()) {
            if (Date.now() - startedAt > 6000) { reject(new Error('传输核心未就绪')); return; }
            window.setTimeout(tick, 150);
            return;
          }
          bridge.dispatchResize();
          var qr = bridge.find('#qr');
          var stage = bridge.find('#stage');
          var width = qr ? qr.width || 0 : 0;
          if (stage && !stage.hidden && width >= 100) { resolve(true); return; }
          if (Date.now() - startedAt > 8000) {
            reject(new Error('二维码渲染超时，请点击「重新截屏」再试一次'));
            return;
          }
          window.setTimeout(tick, 180);
        }
        tick();
      });
    }).then(function () {
      el.stageCover.hidden = true;
      setTransferStatus('正在循环发送…', 'live');
      bridgeResizeBurst();
      mirrorCoreStatus();
    }).catch(function (error) {
      var message = error && error.message ? error.message : String(error);
      el.stageCover.hidden = false;
      el.stageCoverText.textContent = message;
      setTransferStatus(message, 'error');
    });
  }

  function bridgeResizeBurst() {
    if (!state.bridge) return;
    [0, 250, 700, 1400].forEach(function (delay) {
      window.setTimeout(function () {
        if (state.bridge) state.bridge.dispatchResize();
        mirrorCoreStatus();
      }, delay);
    });
  }

  function coreStatusText() {
    var bridge = state.bridge;
    if (!bridge || !bridge.available()) return '';
    var node = bridge.find('#specs');
    if (!node) return '';
    var parts = [];
    Array.prototype.forEach.call(node.childNodes, function (child) {
      if (child.nodeType === 3) parts.push(child.textContent);
      else if (child.nodeType === 1 && child.tagName !== 'BUTTON') parts.push(child.textContent);
    });
    return parts.join(' ').replace(/\s+/g, ' ').trim().replace(/[\s—–-]+$/, '');
  }

  function mirrorCoreStatus() {
    if (state.step !== 3 || !state.bridge || !state.bridge.available()) return;
    var text = coreStatusText();
    if (!text) return;
    if (/choose a file|选择文件/i.test(text)) return;
    setTransferStatus(text, 'live');
  }

  function setTransferStatus(text, kind) {
    el.transferStatus.textContent = text || '';
    el.statusDot.className = 'status-dot' + (kind ? ' ' + kind : '');
  }

  function applySettingsToCore() {
    var bridge = state.bridge;
    if (!bridge || !bridge.available()) return;
    Object.keys(SETTING_SELECTORS).forEach(function (key) {
      var value = state.settings[key];
      if (value) bridge.setValue(SETTING_SELECTORS[key], String(value));
    });
  }

  /* ==================== 其它 ==================== */
  function restart() {
    invalidateStream();
    setStep(1);
    setCaptureStatus(state.screenshot ? '可以重新截屏' : '');
    if (state.screenshot) el.toStep2.disabled = false;
  }

  function resetForNewSource() {
    if (state.screenshot && state.screenshot.url) {
      try { URL.revokeObjectURL(state.screenshot.url); } catch (error) { /* 忽略 */ }
    }
    state.screenshot = null;
    state.streamStarted = false;
    state.linkQr = '';
    state.streamError = '';
    el.previewImg.removeAttribute('src');
    el.previewWrap.hidden = true;
    el.empty.hidden = false;
    el.previewInfo.textContent = '';
    el.fileChip.innerHTML = '';
    el.transferFile.innerHTML = '';
    el.toStep2.disabled = true;
    resetLinkQrUi();
    setCaptureStatus('');
    hideStep1Error();
    if (state.bridge) {
      state.coreReloading = state.bridge.reload().catch(function (error) {
        state.coreReloading = null;
        throw error;
      });
      state.coreReloading.catch(function () {});
    }
    setStep(1);
  }

  function closeWindow() {
    if (state.myWindowId) {
      chrome.windows.remove(state.myWindowId, function () {
        if (chrome.runtime.lastError) window.close();
      });
    } else {
      window.close();
    }
  }

  function escapeHtml(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }

  var toastTimer = null;
  function showToast(message, isError) {
    el.toast.textContent = message;
    el.toast.classList.toggle('error', !!isError);
    el.toast.hidden = false;
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () { el.toast.hidden = true; }, 3600);
  }
})();
