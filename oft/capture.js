/*!
 * capture.js — 排班表截屏（扩展页面侧）
 * ---------------------------------------------------------------------------
 * 流程：
 *   1. 切到发起截图的那个排班标签页并聚焦它的窗口；
 *   2. 让 content/screenshot.js 在页面里把 ant 表格克隆到顶层白色舞台；
 *   3. 这张舞台比窗口大时，分块平移并用 chrome.tabs.captureVisibleTab 抓图；
 *   4. 只保留「姓名」列与日期排班列，拼成一张图；
 *   5. 在图片最上方写“X年X月X日至X月X日排班表”，右上/右下写截屏时间。
 */
(function () {
  'use strict';

  var OFT = (window.OFT = window.OFT || {});
  var TILE_PAD = 16;
  var MAX_TILES = 64;

  function sleep(ms) {
    return new Promise(function (resolve) { window.setTimeout(resolve, ms); });
  }

  function sendToTab(tabId, message, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = window.setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error('排班页面响应超时，请保持页面打开后重试'));
      }, timeoutMs || 20000);
      try {
        chrome.tabs.sendMessage(tabId, message, function (response) {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          var error = chrome.runtime.lastError;
          if (error) { reject(new Error(error.message)); return; }
          if (!response) { reject(new Error('排班页面没有响应')); return; }
          resolve(response);
        });
      } catch (error) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        reject(error);
      }
    });
  }

  function getTab(tabId) {
    return new Promise(function (resolve, reject) {
      chrome.tabs.get(tabId, function (tab) {
        var error = chrome.runtime.lastError;
        if (error) { reject(new Error(error.message)); return; }
        resolve(tab);
      });
    });
  }

  function getCurrentWindow() {
    return new Promise(function (resolve, reject) {
      chrome.windows.getCurrent(function (win) {
        var error = chrome.runtime.lastError;
        if (error) { reject(new Error(error.message)); return; }
        resolve(win);
      });
    });
  }

  function getWindow(windowId) {
    return new Promise(function (resolve, reject) {
      chrome.windows.get(windowId, function (win) {
        var error = chrome.runtime.lastError;
        if (error) { reject(new Error(error.message)); return; }
        resolve(win);
      });
    });
  }

  function focusTab(tab) {
    return new Promise(function (resolve) {
      chrome.tabs.update(tab.id, { active: true }, function () {
        void chrome.runtime.lastError;
        chrome.windows.get(tab.windowId, function (win) {
          var state = win && win.state === 'minimized' ? 'normal' : (win && win.state) || 'normal';
          var done = function () {
            chrome.windows.update(tab.windowId, { focused: true }, function () {
              void chrome.runtime.lastError;
              sleep(240).then(resolve);
            });
          };
          if (state === 'minimized') {
            chrome.windows.update(tab.windowId, { state: 'normal' }, done);
          } else {
            done();
          }
        });
      });
    });
  }

  function ensureContentScript(tabId) {
    return sendToTab(tabId, { type: 'SH_SHOT_PING' }).then(function (response) {
      if (response && response.ok) return true;
      throw new Error('脚本未就绪');
    }).catch(function () {
      return new Promise(function (resolve, reject) {
        try {
          chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['content/screenshot.js'] }, function () {
            var error = chrome.runtime.lastError;
            if (error) { reject(new Error('无法在排班页面注入截屏脚本：' + error.message)); return; }
            sleep(160).then(resolve);
          });
        } catch (error) { reject(error); }
      });
    });
  }

  function captureVisible(windowId) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = window.setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error('浏览器截屏超时'));
      }, 15000);
      chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, function (dataUrl) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        var error = chrome.runtime.lastError;
        if (error) { reject(new Error(error.message)); return; }
        if (!dataUrl) { reject(new Error('浏览器没有返回截图数据')); return; }
        resolve(dataUrl);
      });
    });
  }

  function captureWithRetry(windowId) {
    var attempt = 0;
    function next() {
      return captureVisible(windowId).catch(function (error) {
        attempt++;
        if (attempt >= 4) throw new Error('无法截取页面：' + error.message);
        return sleep(180 + attempt * 160).then(next);
      });
    }
    return next();
  }

  function makeTiles(plan) {
    var viewport = plan.viewport || {};
    var vw = Math.max(200, Number(viewport.width) || 0);
    var vh = Math.max(160, Number(viewport.height) || 0);
    var stepX = Math.max(180, Math.floor(vw - 48));
    var stepY = Math.max(180, Math.floor(vh - 48));
    var left = Number(plan.contentLeft) || 0;
    var right = Number(plan.contentRight) || left + 1;
    var top = Number(plan.contentTop) || 0;
    var bottom = Number(plan.contentBottom) || top + 1;
    var width = Math.max(1, right - left);
    var height = Math.max(1, bottom - top);
    var xs = [];
    var ys = [];
    var x = 0;
    while (true) {
      xs.push(x);
      if (x + stepX >= width || xs.length > 80) break;
      x += stepX;
    }
    var y = 0;
    while (true) {
      ys.push(y);
      if (y + stepY >= height || ys.length > 80) break;
      y += stepY;
    }
    var tiles = [];
    ys.forEach(function (dy) {
      xs.forEach(function (dx) {
        tiles.push({
          x: Math.max(0, Math.round(left + dx - TILE_PAD)),
          y: Math.max(0, Math.round(top + dy - TILE_PAD))
        });
      });
    });
    if (tiles.length > MAX_TILES) {
      throw new Error('排班表尺寸过大（需要 ' + tiles.length + ' 块截图），请先把浏览器窗口调大一些再试');
    }
    return tiles;
  }

  /**
   * 在排班页面里完成截图，返回 plan 与每一块截图。
   * @param {{sourceTabId:number, onProgress?:function}} options
   */
  function captureScheduleTable(options) {
    options = options || {};
    var tabId = Number(options.sourceTabId);
    var progress = typeof options.onProgress === 'function' ? options.onProgress : function () {};
    if (!tabId) return Promise.reject(new Error('没有找到要截图的排班页面'));

    var tab = null;
    var myWindow = null;
    var prepared = false;

    return getTab(tabId).then(function (found) {
      tab = found;
      return getCurrentWindow();
    }).then(function (win) {
      myWindow = win;
      return focusTab(tab);
    }).then(function () {
      return ensureContentScript(tabId);
    }).then(function () {
      return sendToTab(tabId, { type: 'SH_SHOT_PREPARE' });
    }).then(function (plan) {
      if (!plan || !plan.ok) throw new Error((plan && plan.error) || '准备截屏失败');
      prepared = true;
      var tiles = makeTiles(plan);
      progress(0, tiles.length);
      var shots = [];
      function next(index) {
        if (index >= tiles.length) return Promise.resolve(shots);
        var tile = tiles[index];
        return sendToTab(tabId, { type: 'SH_SHOT_MOVE', x: tile.x, y: tile.y }).then(function (moved) {
          if (!moved || !moved.ok) throw new Error((moved && moved.error) || '定位截屏区域失败');
          return sleep(110).then(function () {
            return captureWithRetry(tab.windowId);
          }).then(function (dataUrl) {
            shots.push({
              dataUrl: dataUrl,
              offsetX: moved.offsetX,
              offsetY: moved.offsetY,
              viewport: moved.viewport || plan.viewport
            });
            progress(index + 1, tiles.length);
            return next(index + 1);
          });
        });
      }
      return next(0).then(function (result) {
        return { plan: plan, shots: result, tab: tab };
      });
    }).then(function (result) {
      if (prepared) {
        prepared = false;
        return sendToTab(tabId, { type: 'SH_SHOT_END' }).catch(function () {}).then(function () {
          return result;
        });
      }
      return result;
    }, function (error) {
      if (prepared) {
        prepared = false;
        return sendToTab(tabId, { type: 'SH_SHOT_END' }).catch(function () {}).then(function () {
          throw error;
        });
      }
      throw error;
    }).then(function (result) {
      if (!myWindow) return result;
      return new Promise(function (resolve) {
        chrome.windows.update(myWindow.id, { focused: true }, function () {
          void chrome.runtime.lastError;
          resolve(result);
        });
      });
    }, function (error) {
      if (!myWindow) throw error;
      return new Promise(function (resolve, reject) {
        chrome.windows.update(myWindow.id, { focused: true }, function () {
          void chrome.runtime.lastError;
          reject(error);
        });
      });
    });
  }

  /* ==================== 图片合成 ==================== */

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('截图数据解码失败')); };
      img.src = src;
    });
  }

  function formatYMD(date) {
    return date.year + '-' + String(date.month).padStart(2, '0') + '-' + String(date.day).padStart(2, '0');
  }

  function buildTitle(meta) {
    if (!meta || !meta.start) return '排班表';
    var start = meta.start;
    var end = meta.end || start;
    return start.year + '年' + start.month + '月' + start.day + '日至' + end.month + '月' + end.day + '日排班表';
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function formatDateTime(ts) {
    var d = ts ? new Date(ts) : new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  var FONT_STACK = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif';

  function compose(plan, shots, options) {
    if (!plan || !shots || !shots.length) return Promise.reject(new Error('没有可合成的截图'));
    var meta = plan.meta || {};
    var viewport = plan.viewport || { width: shots[0].imageWidth, height: shots[0].imageHeight };
    var name = plan.name || null;
    var days = plan.days || null;
    var parts = [];
    if (name && days && name.right > days.left) {
      parts.push({ left: Math.min(name.left, days.left), right: Math.max(name.right, days.right) });
    } else {
      if (name) parts.push({ left: name.left, right: name.right });
      if (days) parts.push({ left: days.left, right: days.right });
    }
    if (!parts.length) return Promise.reject(new Error('排班表没有可输出的列'));

    var contentLeft = Math.min.apply(null, parts.map(function (p) { return p.left; }));
    var contentTop = Number(plan.contentTop) || 0;
    var contentBottom = Number(plan.contentBottom) || contentTop + 1;

    return loadImage(shots[0].dataUrl).then(function (first) {
      var firstViewport = shots[0].viewport || viewport;
      var sx = first.naturalWidth / Math.max(1, firstViewport.width);
      var sy = first.naturalHeight / Math.max(1, firstViewport.height);
      if (!sx || !sy) throw new Error('截图尺寸异常');

      var scale = Math.max(0.5, Math.min(sx, sy));
      var partWidths = parts.map(function (p) { return Math.max(1, Math.round((p.right - p.left) * sx)); });
      var contentWidth = partWidths.reduce(function (sum, w) { return sum + w; }, 0);
      var contentHeight = Math.max(1, Math.round((contentBottom - contentTop) * sy));
      var pad = Math.max(10, Math.round(14 * scale));
      var title = options && options.title ? options.title : buildTitle(meta);
      var timeText = formatDateTime(options && options.timestamp);
      var titleSize = Math.max(14, Math.round(22 * scale));
      var timeSize = Math.max(10, Math.round(11 * scale));
      var padTop = Math.max(10, Math.round(14 * sy));
      var gap = Math.max(6, Math.round(8 * sy));
      var bottomPad = Math.max(8, Math.round(10 * sy));

      // 先量一下标题与时间，空间够就把截屏时间放在标题同一行的最右侧
      var measureCtx = document.createElement('canvas').getContext('2d');
      var timeLabel = '截屏时间：' + timeText;
      measureCtx.font = '400 ' + timeSize + 'px ' + FONT_STACK;
      var timeWidth = measureCtx.measureText(timeLabel).width;
      measureCtx.font = '700 ' + titleSize + 'px ' + FONT_STACK;
      var titleEstimate = measureCtx.measureText(title).width;
      var sideBySide = contentWidth >= titleEstimate + timeWidth * 2 + 48 * scale;
      var titleMaxWidth = sideBySide
        ? Math.max(140 * scale, contentWidth - timeWidth * 2 - 2 * 26 * scale)
        : Math.max(120 * scale, contentWidth - 12 * scale);
      var finalTitleSize = titleSize;
      measureCtx.font = '700 ' + finalTitleSize + 'px ' + FONT_STACK;
      while (measureCtx.measureText(title).width > titleMaxWidth && finalTitleSize > 13 * scale) {
        finalTitleSize -= 1;
        measureCtx.font = '700 ' + finalTitleSize + 'px ' + FONT_STACK;
      }
      var headHeight = sideBySide
        ? padTop + Math.max(finalTitleSize, timeSize) + bottomPad
        : padTop + finalTitleSize + gap + timeSize + bottomPad;
      var canvasWidth = Math.ceil(contentWidth + pad * 2);
      var canvasHeight = Math.ceil(headHeight + contentHeight + pad);
      if (canvasWidth > 32000 || canvasHeight > 32000 || canvasWidth * canvasHeight > 160000000) {
        throw new Error('排班表图片过大，无法生成，请缩小表格范围后重试');
      }

      var canvas = document.createElement('canvas');
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
      var ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvasWidth, canvasHeight);

      var pending = Promise.resolve();
      shots.forEach(function (shot) {
        pending = pending.then(function () {
          return loadImage(shot.dataUrl).then(function (img) {
            var shotVp = shot.viewport || viewport;
            var rx = img.naturalWidth / Math.max(1, shotVp.width);
            var ry = img.naturalHeight / Math.max(1, shotVp.height);
            var visX0 = shot.offsetX;
            var visX1 = shot.offsetX + shotVp.width;
            var visY0 = shot.offsetY;
            var visY1 = shot.offsetY + shotVp.height;
            var y0 = Math.max(contentTop, visY0);
            var y1 = Math.min(contentBottom, visY1);
            if (y1 <= y0) return;

            var destLeftBase = pad;
            parts.forEach(function (part, index) {
              if (index > 0) destLeftBase += partWidths[index - 1];
              var x0 = Math.max(part.left, visX0);
              var x1 = Math.min(part.right, visX1);
              if (x1 <= x0) return;

              var srcX0 = Math.round((x0 - visX0) * rx);
              var srcX1 = Math.round((x1 - visX0) * rx);
              var srcY0 = Math.round((y0 - visY0) * ry);
              var srcY1 = Math.round((y1 - visY0) * ry);
              var dstX0 = Math.round(destLeftBase + (x0 - part.left) * sx);
              var dstX1 = Math.round(destLeftBase + (x1 - part.left) * sx);
              var dstY0 = Math.round(headHeight + (y0 - contentTop) * sy);
              var dstY1 = Math.round(headHeight + (y1 - contentTop) * sy);
              if (srcX1 <= srcX0 || srcY1 <= srcY0 || dstX1 <= dstX0 || dstY1 <= dstY0) return;
              ctx.drawImage(img, srcX0, srcY0, srcX1 - srcX0, srcY1 - srcY0,
                dstX0, dstY0, dstX1 - dstX0, dstY1 - dstY0);
            });
          });
        });
      });

      return pending.then(function () {
        // ---- 顶部标题与截屏时间 ----
        var titleBaseline = padTop + finalTitleSize;
        ctx.fillStyle = '#152423';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.font = '700 ' + finalTitleSize + 'px ' + FONT_STACK;
        ctx.fillText(title, pad + contentWidth / 2, titleBaseline);

        ctx.fillStyle = '#6b7c7a';
        ctx.textAlign = 'right';
        ctx.font = '400 ' + timeSize + 'px ' + FONT_STACK;
        var timeBaseline = sideBySide ? titleBaseline : titleBaseline + gap + timeSize;
        ctx.fillText(timeLabel, pad + contentWidth, timeBaseline);

        ctx.fillStyle = '#e6edeb';
        ctx.fillRect(pad, headHeight - Math.max(1, Math.round(1 * sy)), contentWidth, Math.max(1, Math.round(1 * sy)));

        return new Promise(function (resolve, reject) {
          canvas.toBlob(function (blob) {
            if (!blob) { reject(new Error('生成排班表图片失败')); return; }
            var start = meta.start || { year: new Date().getFullYear(), month: 1, day: 1 };
            var end = meta.end || start;
            var fileName = '排班表_' + formatYMD(start) + '_至_' + formatYMD(end) + '.png';
            var file = new File([blob], fileName, { type: 'image/png' });
            resolve({
              file: file,
              blob: blob,
              url: URL.createObjectURL(blob),
              width: canvas.width,
              height: canvas.height,
              title: title,
              meta: meta,
              timeText: timeText
            });
          }, 'image/png');
        });
      });
    });
  }

  OFT.capture = {
    captureScheduleTable: captureScheduleTable,
    compose: compose,
    buildTitle: buildTitle,
    formatYMD: formatYMD,
    formatDateTime: formatDateTime
  };
})();
