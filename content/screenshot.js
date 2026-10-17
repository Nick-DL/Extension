/*!
 * screenshot.js — 排班表截屏辅助（content script）
 * ---------------------------------------------------------------------------
 * 只做页面内的准备工作，真正的截图由扩展页面调用 chrome.tabs.captureVisibleTab 完成：
 *   1. 找到排班 ant-table，克隆到顶层白色舞台（不改动原表格）；
 *   2. 解除内部滚动 / 吸顶 / 固定列，让整张表完整展开；
 *   3. 返回「姓名」列与日期列的位置；
 *   4. 收到 SH_SHOT_MOVE 时平移舞台，让扩展逐块截屏；
 *   5. SH_SHOT_END 恢复页面。
 *
 * 这样原页面不会被重排，浮窗、页面固定栏也不会挡住表格。
 */
(function () {
  'use strict';

  if (window.__SH_SCREENSHOT_LOADED__) return;
  window.__SH_SCREENSHOT_LOADED__ = true;

  var STAGE_ID = '__sh_shot_stage';
  var BACKDROP_ID = '__sh_shot_backdrop';
  var STYLE_ID = '__sh_shot_style';
  var state = null;

  function qsa(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function textOf(node) {
    return node ? String(node.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

  function isVisible(el) {
    if (!el) return false;
    try {
      return !!(el.getClientRects && el.getClientRects().length);
    } catch (error) { return false; }
  }

  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  }

  function findTableWrapper() {
    var wrappers = qsa('.ant-table-wrapper').filter(function (el) {
      return el.querySelectorAll('.ant-table-tbody tr.ant-table-row').length > 0;
    });
    if (!wrappers.length) {
      wrappers = qsa('.ant-table').filter(function (el) {
        return el.querySelectorAll('.ant-table-tbody tr.ant-table-row').length > 0;
      });
    }
    if (!wrappers.length) return null;
    var scored = wrappers.map(function (el) {
      var headers = qsa('.ant-table-thead th', el);
      var hasName = headers.some(function (th) { return textOf(th).indexOf('姓名') >= 0; });
      var rows = el.querySelectorAll('.ant-table-tbody tr.ant-table-row').length;
      var r = el.getBoundingClientRect();
      return { el: el, hasName: hasName, rows: rows, area: Math.max(0, r.width) * Math.max(0, r.height) };
    });
    scored.sort(function (a, b) {
      if (a.hasName !== b.hasName) return a.hasName ? -1 : 1;
      if (a.rows !== b.rows) return b.rows - a.rows;
      return b.area - a.area;
    });
    return scored[0].el;
  }

  function captureCss() {
    var s = '#' + STAGE_ID;
    return [
      '#' + BACKDROP_ID + '{position:fixed;inset:0;z-index:2147483646;background:#fff;margin:0;padding:0}',
      s + '{position:fixed;left:0;top:0;z-index:2147483647;background:#fff;margin:0;padding:0;',
      'transform:translate3d(0,0,0);transform-origin:0 0;will-change:transform;overflow:visible}',
      s + ' *{box-sizing:border-box}',
      s + ' .ant-table-wrapper,' + s + ' .ant-table,' + s + ' .ant-table-container,' + s + ' .ant-table-content,',
      s + ' .ant-table-header,' + s + ' .ant-table-body{overflow:visible !important;max-height:none !important;',
      'height:auto !important;max-width:none !important;width:auto !important;min-width:0 !important}',
      s + ' .ant-table-body{position:static !important}',
      s + ' .ant-table-cell-fix-left,' + s + ' .ant-table-cell-fix-right,',
      s + ' .ant-table-thead > tr > th,' + s + ' .ant-table-tbody > tr > td,',
      s + ' .ant-table-sticky-holder,' + s + ' .ant-table-sticky-scroll{position:static !important;',
      'left:auto !important;right:auto !important;z-index:auto !important;box-shadow:none !important}',
      s + ' .ant-table-sticky-holder,' + s + ' .ant-table-sticky-scroll{display:none !important}',
      s + ' .ant-table-cell-scrollbar{visibility:hidden !important}',
      s + ' .ant-table-cell-fix-left-last::after,' + s + ' .ant-table-cell-fix-right-first::after{display:none !important}',
      // 表格正在刷新时，去掉加载遮罩/模糊，避免截出半透明的一层
      s + ' .ant-spin-spinning{display:none !important}',
      s + ' .ant-spin-blur{opacity:1 !important;filter:none !important}',
      s + ' *{animation:none !important;transition:none !important}',
      // 插件自身的浮窗 / 快捷入口 / 提示条都不参与截图
      '#scheduling-helper-panel,#sh-quick-entry,#sh-toast-container,.sh-modal-overlay{visibility:hidden !important}',
      // 隐藏窗口与内部滚动条，避免占掉截图边缘
      'html,body{scrollbar-width:none !important;-ms-overflow-style:none !important}',
      'html::-webkit-scrollbar,body::-webkit-scrollbar,*::-webkit-scrollbar{width:0 !important;height:0 !important;display:none !important;background:transparent !important}',
      // 避免页面在 html/body 上使用 transform / filter 时改变 fixed 舞台的参照系
      'html,body{transform:none !important;filter:none !important;perspective:none !important;contain:none !important}'
    ].join('');
  }

  function injectStyle() {
    var old = document.getElementById(STYLE_ID);
    if (old) old.remove();
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = captureCss();
    (document.head || document.documentElement).appendChild(style);
  }

  function cleanup() {
    var stage = document.getElementById(STAGE_ID);
    if (stage) stage.remove();
    var backdrop = document.getElementById(BACKDROP_ID);
    if (backdrop) backdrop.remove();
    var style = document.getElementById(STYLE_ID);
    if (style) style.remove();
    if (state && state.savedScroll) {
      try { window.scrollTo(state.savedScroll.x, state.savedScroll.y); } catch (error) { /* 忽略 */ }
    }
    state = null;
  }

  /* ------------------------------------------------------------ 日期解析 */
  function parseMonthDay(text) {
    text = String(text || '').replace(/\s+/g, ' ').trim();
    var full = text.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
    if (full) {
      var fy = +full[1], fm = +full[2], fd = +full[3];
      if (fm >= 1 && fm <= 12 && fd >= 1 && fd <= 31) return { year: fy, month: fm, day: fd };
    }
    var m = text.match(/(\d{1,2})\s*[-/.月]\s*(\d{1,2})/);
    if (m) {
      var month = +m[1], day = +m[2];
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return { month: month, day: day };
    }
    // 月视图：表头只有“01 / 周X”，月份从日期选择器读取
    var dm = text.match(/^\s*(\d{1,2})(?=\s*(?:周|$))/);
    if (dm) {
      var d = +dm[1];
      if (d >= 1 && d <= 31) return { day: d };
    }
    return null;
  }

  function addDays(date, n) {
    var d = new Date(date.year, date.month - 1, date.day);
    d.setDate(d.getDate() + n);
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
  }

  function resolveMeta(dayThs) {
    var info = null;
    try {
      var getter = window.__SH_SCREENSHOT_META_GETTER__;
      if (typeof getter === 'function') info = getter();
    } catch (error) { info = null; }

    var firstHeader = dayThs && dayThs.length ? parseMonthDay(textOf(dayThs[0])) : null;
    var lastHeader = dayThs && dayThs.length ? parseMonthDay(textOf(dayThs[dayThs.length - 1])) : null;

    // 优先用插件已解析的工作周（content.js 的 weekInfo）：
    // 它包含完整年份，能正确处理跨年周；并且与表头首日一致时才采用。
    if (info && info.monday) {
      var mondayMatch = String(info.monday).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (mondayMatch) {
        var mondayDate = { year: +mondayMatch[1], month: +mondayMatch[2], day: +mondayMatch[3] };
        if (firstHeader && !firstHeader.year &&
          firstHeader.month === mondayDate.month && firstHeader.day === mondayDate.day) {
          return { start: mondayDate, end: addDays(mondayDate, 6), monday: info.monday };
        }
      }
    }

    var picker = document.querySelector('.ant-picker input');
    var pickerValue = picker ? String(picker.value || '').trim() : '';
    var pickerMonth = null;
    var pm = pickerValue.match(/^\s*(\d{4})\s*[-/.年]\s*(\d{1,2})\s*(?:月)?\s*$/);
    if (pm) {
      var py = +pm[1], pmo = +pm[2];
      if (pmo >= 1 && pmo <= 12) pickerMonth = { year: py, month: pmo };
    }

    var isMonthView = !!(dayThs && dayThs.length > 10);
    var refYear = null;
    var refMonth = null;
    if (info && info.monday) {
      var mm = String(info.monday).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (mm) { refYear = +mm[1]; refMonth = +mm[2]; }
    }
    if (pickerMonth && (isMonthView || !refYear)) {
      refYear = pickerMonth.year;
      refMonth = pickerMonth.month;
    }
    if (!refYear) {
      var wy = pickerValue.match(/(\d{4})/);
      if (wy) refYear = +wy[1];
    }
    if (!refYear) refYear = new Date().getFullYear();

    var first = firstHeader;
    var last = lastHeader;

    function resolve(md) {
      if (!md) return null;
      if (md.year) return { year: md.year, month: md.month, day: md.day };
      var month = md.month != null ? md.month : refMonth;
      if (!month) return null;
      var year = refYear;
      var anchor = refMonth || month;
      if (anchor >= 10 && month <= 3) year += 1;
      else if (anchor <= 3 && month >= 10) year -= 1;
      return { year: year, month: month, day: md.day };
    }

    var start = resolve(first);
    var end = resolve(last);
    if (!start && info && info.monday) {
      var monday = String(info.monday).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (monday) start = { year: +monday[1], month: +monday[2], day: +monday[3] };
    }
    if (start && !end) {
      if (isMonthView) {
        end = { year: start.year, month: start.month, day: new Date(start.year, start.month, 0).getDate() };
      } else {
        end = addDays(start, 6);
      }
    }
    if (start && end) {
      var a = Date.UTC(start.year, start.month - 1, start.day);
      var b = Date.UTC(end.year, end.month - 1, end.day);
      var maxDays = (isMonthView ? 31 : 10) * 86400000;
      if (b - a < 0 || b - a > maxDays) {
        end = isMonthView
          ? { year: start.year, month: start.month, day: new Date(start.year, start.month, 0).getDate() }
          : addDays(start, 6);
      }
    }
    return { start: start, end: end, monday: info && info.monday ? info.monday : null };
  }

  /* ------------------------------------------------------------ 准备截图 */
  function prepare() {
    cleanup();
    var wrapper = findTableWrapper();
    if (!wrapper) throw new Error('未找到排班表格（ant-table），请确认页面已显示排班表');
    var rows = qsa('.ant-table-tbody tr.ant-table-row', wrapper);
    if (!rows.length) throw new Error('排班表格暂无数据行，无法截屏');

    var savedScroll = { x: window.scrollX || window.pageXOffset || 0, y: window.scrollY || window.pageYOffset || 0 };
    var originTables = qsa('table', wrapper);
    var originRects = originTables.map(function (table) {
      try { return rectOf(table); } catch (error) { return null; }
    }).filter(Boolean);
    if (!originRects.length) throw new Error('未找到排班表格的 table 元素');
    var maxWidth = Math.max.apply(null, originRects.map(function (r) { return r.width; }));

    var clone = wrapper.cloneNode(true);
    clone.removeAttribute('id');
    qsa('[id]', clone).forEach(function (node) { node.removeAttribute('id'); });
    qsa('script,iframe,object,embed', clone).forEach(function (node) { node.remove(); });

    var cloneTables = qsa('table', clone);
    cloneTables.forEach(function (table, index) {
      var rect = originRects[index] || originRects[originRects.length - 1];
      if (rect && rect.width > 0) {
        var width = Math.ceil(rect.width);
        table.style.setProperty('width', width + 'px', 'important');
        table.style.setProperty('min-width', width + 'px', 'important');
        table.style.setProperty('table-layout', 'fixed', 'important');
      }
    });

    clone.style.setProperty('width', Math.ceil(maxWidth + 2) + 'px', 'important');
    clone.style.setProperty('max-width', 'none', 'important');
    clone.style.setProperty('min-width', '0', 'important');
    clone.style.setProperty('overflow', 'visible', 'important');
    clone.style.setProperty('margin', '0', 'important');

    var backdrop = document.createElement('div');
    backdrop.id = BACKDROP_ID;
    var stage = document.createElement('div');
    stage.id = STAGE_ID;
    var holder = document.createElement('div');
    holder.style.cssText = 'position:relative;display:block;background:#fff;margin:0;padding:0;overflow:visible;';
    holder.appendChild(clone);
    stage.appendChild(holder);

    var parent = document.body || document.documentElement;
    parent.appendChild(backdrop);
    parent.appendChild(stage);
    injectStyle();

    // 强制一次布局，确保所有行展开后再量尺寸
    void stage.offsetWidth;

    var cloneRows = qsa('.ant-table-tbody tr.ant-table-row', clone);
    if (!cloneRows.length) { cleanup(); throw new Error('排班表克隆失败'); }
    var lastRow = cloneRows[cloneRows.length - 1];
    var headerCells = qsa('.ant-table-thead th', clone).filter(isVisible);

    function isDayHeader(th) {
      var text = textOf(th);
      return /\d{1,2}\s*[-/.月]\s*\d{1,2}/.test(text) || /周[日一二三四五六]/.test(text);
    }

    var dayThs = headerCells.filter(isDayHeader);
    if (!dayThs.length) {
      // 有些主题的日期只写在表头子节点里，这里再放宽一次
      dayThs = headerCells.filter(function (th) {
        var text = textOf(th);
        return /班次\s*[12]/.test(text);
      });
    }

    var nameTh = headerCells.filter(function (th) { return textOf(th).indexOf('姓名') >= 0; })[0];

    var dayRange = null;
    if (dayThs.length) {
      var dayRects = dayThs.map(rectOf);
      dayRange = {
        left: Math.min.apply(null, dayRects.map(function (r) { return r.left; })),
        right: Math.max.apply(null, dayRects.map(function (r) { return r.right; }))
      };
    } else {
      // 兜底：用数据行里带 tooltip 的格子判断日期列
      var sampleRow = cloneRows[0];
      var sampleCells = qsa('td', sampleRow);
      var dayCells = sampleCells.filter(function (td) { return !!td.querySelector('[class*="tooltip"]'); });
      if (dayCells.length) {
        var cellRects = dayCells.map(rectOf);
        dayRange = {
          left: Math.min.apply(null, cellRects.map(function (r) { return r.left; })),
          right: Math.max.apply(null, cellRects.map(function (r) { return r.right; }))
        };
      }
    }
    if (!dayRange || !(dayRange.right > dayRange.left)) {
      cleanup();
      throw new Error('未能识别排班日期列，请确认表格处于「周 + 两段排班」视图');
    }

    if (!nameTh) {
      // 没有“姓名”表头时退化为：日期列左侧的第一列
      nameTh = headerCells.filter(function (th) {
        return !isDayHeader(th) && textOf(th).length > 0;
      })[0];
    }
    if (!nameTh) { cleanup(); throw new Error('未找到「姓名」列'); }

    var nameRect = rectOf(nameTh);
    var nameRange = { left: nameRect.left, right: nameRect.right };

    var theadRects = qsa('.ant-table-thead', clone).filter(isVisible).map(rectOf);
    var tableTop = theadRects.length
      ? Math.min.apply(null, theadRects.map(function (r) { return r.top; }))
      : Math.min.apply(null, qsa('table', clone).map(function (t) { return rectOf(t).top; }));
    var lastRowRect = rectOf(lastRow);
    var tableBottom = lastRowRect.bottom;

    // 向外扩 1px，保留表格边框
    nameRange.left -= 1;
    nameRange.right += 1;
    dayRange.left -= 1;
    dayRange.right += 1;
    tableTop -= 1;
    tableBottom += 1;

    var contentLeft = Math.min(nameRange.left, dayRange.left);
    var contentRight = Math.max(nameRange.right, dayRange.right);
    var contentTop = tableTop;
    var contentBottom = tableBottom;
    if (!(contentRight > contentLeft) || !(contentBottom > contentTop)) {
      cleanup();
      throw new Error('排班表格尺寸异常，无法截屏');
    }

    stage.style.width = Math.ceil(contentRight + 8) + 'px';
    stage.style.height = Math.ceil(contentBottom + 8) + 'px';
    void stage.offsetWidth;

    var viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    var viewportHeight = document.documentElement.clientHeight || window.innerHeight;

    state = {
      stage: stage,
      backdrop: backdrop,
      clone: clone,
      offsetX: 0,
      offsetY: 0,
      savedScroll: savedScroll,
      name: nameRange,
      days: dayRange,
      contentLeft: contentLeft,
      contentRight: contentRight,
      contentTop: contentTop,
      contentBottom: contentBottom
    };

    return {
      ok: true,
      meta: resolveMeta(dayThs),
      viewport: { width: viewportWidth, height: viewportHeight },
      name: nameRange,
      days: dayRange,
      contentLeft: contentLeft,
      contentRight: contentRight,
      contentTop: contentTop,
      contentBottom: contentBottom,
      rowCount: cloneRows.length,
      dayCount: dayThs.length || undefined
    };
  }

  /* ------------------------------------------------------------ 平移舞台 */
  function moveTo(x, y) {
    if (!state || !state.stage) return Promise.reject(new Error('截图会话已结束，请重试'));
    var offsetX = Math.max(0, Math.round(Number(x) || 0));
    var offsetY = Math.max(0, Math.round(Number(y) || 0));
    state.offsetX = offsetX;
    state.offsetY = offsetY;
    state.stage.style.transform = 'translate3d(' + (-offsetX) + 'px,' + (-offsetY) + 'px,0)';
    return new Promise(function (resolve, reject) {
      var done = false;
      function finish() {
        if (done) return;
        done = true;
        resolve({
          ok: true,
          offsetX: offsetX,
          offsetY: offsetY,
          viewport: {
            width: document.documentElement.clientWidth || window.innerWidth,
            height: document.documentElement.clientHeight || window.innerHeight
          }
        });
      }
      function fail() {
        if (done) return;
        done = true;
        reject(new Error('排班页面渲染超时，请保持页面在前台后重试'));
      }
      requestAnimationFrame(function () {
        requestAnimationFrame(finish);
      });
      window.setTimeout(fail, 6000);
    });
  }

  /* ------------------------------------------------------------ 消息入口 */
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || typeof message.type !== 'string' || message.type.indexOf('SH_SHOT_') !== 0) return;
    try {
      if (message.type === 'SH_SHOT_PING') {
        sendResponse({ ok: true, ready: true });
        return;
      }
      if (message.type === 'SH_SHOT_PREPARE') {
        sendResponse(prepare());
        return;
      }
      if (message.type === 'SH_SHOT_MOVE') {
        moveTo(message.x, message.y).then(function (result) { sendResponse(result); }, function (error) {
          sendResponse({ ok: false, error: String(error && error.message ? error.message : error) });
        });
        return true;
      }
      if (message.type === 'SH_SHOT_END') {
        cleanup();
        sendResponse({ ok: true });
        return;
      }
      sendResponse({ ok: false, error: '未知的截图指令' });
    } catch (error) {
      cleanup();
      sendResponse({ ok: false, error: String(error && error.message ? error.message : error) });
    }
  });

  // 页面卸载时清理，避免留下白色舞台
  window.addEventListener('pagehide', function () {
    if (state) cleanup();
  });
})();
