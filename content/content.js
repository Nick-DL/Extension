/**
 * Content Script - 排班辅助插件主逻辑
 * 所有 UI 事件通过 data-action 代理，无内联 onclick/onchange（兼容 CSP）
 */

(function () {
  'use strict';

  const A = ScheduleAlgorithm;

  // ==================== 全局状态 ====================
  let state = {
    currentStep: 1,
    doctors: [],
    workdayConfig: [true, true, true, true, true, false, false],
    outpatientGeneral: {},
    outpatientSimple: [],
    outpatientGaoxin: [],
    outpatientZitong: [],
    special: {},
    dutyAssigned: {},
    baiban1Flags: [],
    traineeFlags: {},
    dutyOrder: [],
    cancelPreHolidayZhongban: false
  };

  let extEnabled = false, panelVisible = false, isMinimized = false;
  let restoreFetch = null, classMap = {}, classIdMap = {}, locationId = '';
  let originalData = null;
  let weekInfo = getWeekInfo(new Date());
  let dragSrcIdx = null, dragOpacityTimer = null;
  let prevWeekOutpatientPreview = null;  // { outpatientGeneral, outpatientGaoxin, outpatientZitong, conflicts:[] }
  let prevWeekOutpatientLoaded = false;
  let prevWeekDutyOrderPreview = null;   // { sourceMonday, order:[doctorId×8], details:[{dayIdx,dayLabel,doctorId,doctorName}], missingDays:[] }

  // ==================== 工具函数 ====================
  function getDoctor(id) { return A.getDoctor(state.doctors, id); }
  function docOptsHtml() {
    return state.doctors.filter(d => d.type !== 'trainee')
      .map(d => `<option value="${d.id}">${d.name}</option>`).join('');
  }
  function docOptsHtmlSelected(selId) {
    return state.doctors.filter(d => d.type !== 'trainee')
      .map(d => `<option value="${d.id}" ${d.id === selId ? 'selected' : ''}>${d.name}</option>`).join('');
  }

  function showToast(msg, type) {
    const c = document.getElementById('sh-toast-container'); if (!c) return;
    const t = document.createElement('div');
    t.className = `sh-toast ${type || 'success'}`; t.textContent = msg;
    t.addEventListener('click', () => t.remove()); c.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  /**
   * Material 风格自定义 Modal（覆盖在浮窗面板内部）
   * @param {Object} opts
   *   - title      {string}  标题
   *   - message    {string}  正文（支持 \n 换行）
   *   - icon       {string}  Material Icons 图标名，可选
   *   - okLabel    {string}  确定按钮文字，默认"确定"
   *   - cancelLabel {string|null} 取消按钮文字，传 null 则隐藏取消按钮
   *   - type       {'confirm'|'select'} 类型，默认 confirm
   *   - selectOptions {Array<{value,label}>} type='select' 时的下拉选项
   * @returns {Promise<boolean|string|null>} confirm→true/false，select→选中的value或null
   */
  function showModal(opts) {
    return new Promise(function (resolve) {
      var panel = document.getElementById('scheduling-helper-panel');
      if (!panel) { resolve(false); return; }

      var existing = panel.querySelector('.sh-modal-overlay');
      if (existing) existing.remove();

      var title = opts.title || '提示';
      var message = opts.message || '';
      var icon = opts.icon || '';
      var okLabel = opts.okLabel || '确定';
      var cancelLabel = opts.cancelLabel !== undefined ? opts.cancelLabel : '取消';
      var type = opts.type || 'confirm';
      var selectOptions = opts.selectOptions || [];

      var overlay = document.createElement('div');
      overlay.className = 'sh-modal-overlay';

      var bodyHTML = '';
      if (type === 'select' && selectOptions.length) {
        bodyHTML = '<div class="sh-modal-select-wrap"><select class="sh-modal-select">' +
          selectOptions.map(function (o, i) {
            var v = o.value !== undefined ? o.value : i;
            return '<option value="' + v + '">' + o.label + '</option>';
          }).join('') +
          '</select></div>';
      }

      overlay.innerHTML =
        '<div class="sh-modal-card">' +
          '<div class="sh-modal-header">' +
            (icon ? '<span class="material-icons sh-modal-icon">' + icon + '</span>' : '') +
            '<span class="sh-modal-title">' + title + '</span>' +
          '</div>' +
          '<div class="sh-modal-body">' +
            '<p class="sh-modal-message">' + message + '</p>' +
            bodyHTML +
          '</div>' +
          '<div class="sh-modal-footer">' +
            (cancelLabel !== null
              ? '<button class="sh-modal-btn sh-modal-btn-cancel">' + cancelLabel + '</button>'
              : '') +
            '<button class="sh-modal-btn sh-modal-btn-ok">' + okLabel + '</button>' +
          '</div>' +
        '</div>';

      panel.appendChild(overlay);
      requestAnimationFrame(function () { overlay.classList.add('visible'); });

      var okBtn = overlay.querySelector('.sh-modal-btn-ok');
      var cancelBtn = overlay.querySelector('.sh-modal-btn-cancel');
      var selectEl = overlay.querySelector('.sh-modal-select');

      function close(result) {
        overlay.classList.remove('visible');
        setTimeout(function () { overlay.remove(); }, 250);
        resolve(result);
      }

      okBtn.addEventListener('click', function () {
        if (type === 'select' && selectEl) {
          close(selectEl.value);
        } else {
          close(true);
        }
      });

      if (cancelBtn) {
        cancelBtn.addEventListener('click', function () {
          close(type === 'select' ? null : false);
        });
      }

      overlay.addEventListener('click', function (e) {
        if (e.target === overlay && cancelLabel !== null) {
          close(type === 'select' ? null : false);
        }
      });

      var escHandler = function (e) {
        if (e.key === 'Escape') {
          document.removeEventListener('keydown', escHandler);
          close(type === 'select' ? null : false);
        }
      };
      document.addEventListener('keydown', escHandler);

      setTimeout(function () { okBtn.focus(); }, 100);
    });
  }

  // ==================== 初始化 ====================
  function init() {
    for (let d = 0; d < 7; d++) state.outpatientGeneral[d] = { am: null, pm: null };
    injectPanel(); injectQuickEntry(); injectToastContainer();
    chrome.runtime.onMessage.addListener(handleMessage);

    // 判断是否在医院排班页面：是则默认启用，否则查 background 状态
    const isHospitalPage = /10\.66\.66\.151\/app\/attendance\/schedules\/hospital/.test(window.location.href);
    if (isHospitalPage) {
      extEnabled = true;
      onEnabled();
      chrome.runtime.sendMessage({ type: 'SET_ENABLED', enabled: true });
    } else {
      chrome.runtime.sendMessage({ type: 'GET_STATE' }, (resp) => {
        if (resp && resp.success && resp.data.enabled) { extEnabled = true; onEnabled(); }
      });
    }
  }

  function handleMessage(message, sender, sendResponse) {
    switch (message.type) {
      case 'TOGGLE_ENABLED': extEnabled = message.enabled; extEnabled ? onEnabled() : onDisabled(); break;
      case 'OPEN_PANEL': extEnabled ? togglePanel(true) : showToast('请先在扩展弹窗中启用辅助插件', 'warn'); break;
      case 'REFRESH_DATA': refreshAllData().then(() => { showToast('数据已刷新', 'success'); renderPanel(); }); break;
      case 'RESTORE_DATA': restoreOriginalData(); break;
    }
    sendResponse({ success: true }); return true;
  }

  function onEnabled() {
    showToast('排班辅助插件已启用', 'success');
    document.getElementById('sh-quick-entry').classList.remove('hidden');
    restoreFetch = ScheduleAPI.interceptScheduleAPI();
    window.addEventListener('scheduling-api-blocked', () => showToast('主页面排班修改已被拦截，请通过辅助面板操作', 'warn'));
    detectWeekInfo();
    refreshAllData().then(() => {
      console.log('[排班辅助] 数据加载完成, 医生' + state.doctors.length + '人');
      originalData = JSON.parse(JSON.stringify({
        doctors: state.doctors, outpatientGeneral: state.outpatientGeneral,
        outpatientSimple: state.outpatientSimple, outpatientGaoxin: state.outpatientGaoxin,
        outpatientZitong: state.outpatientZitong, special: state.special,
        dutyAssigned: state.dutyAssigned, workdayConfig: state.workdayConfig
      }));
      chrome.runtime.sendMessage({ type: 'UPDATE_ORIGINAL_DATA', data: originalData });
      syncStateToBackground();
      chrome.runtime.sendMessage({ type: 'UPDATE_WEEK_INFO', weekInfo });
      togglePanel(true);
      applyClassBadgeColors();
      setupTableWatcher();
    }).catch(err => { console.error('[排班辅助] 数据加载失败:', err.message); showToast('数据加载失败', 'error'); });
  }

  function onDisabled() {
    togglePanel(false); document.getElementById('sh-quick-entry').classList.add('hidden');
    if (restoreFetch) { restoreFetch(); restoreFetch = null; }
    removeClassColorBars(); clearPageTableCells(); clearClassBadgeColors(); teardownTableWatcher();
    showToast('排班辅助插件已关闭', 'info');
  }

  // ==================== 周信息检测 ====================
  function detectWeekInfo() {
    // 优先从 Ant Design picker 中读取
    const pickerVal = readCurrentWeekFromPicker();
    if (pickerVal) {
      // 还需要年份，从picker input value获取
      const pickerInput = document.querySelector('.ant-picker input');
      const val = pickerInput?.value || '';
      const ym = val.match(/(\d{4})-(\d{1,2})周/);
      if (ym) {
        const year = parseInt(ym[1], 10);
        const week = parseInt(ym[2], 10);
        // 从picker下拉中获取具体的周一日期（需要打开picker）
        // 作为fallback，用ISO周计算近似值
        const approxMonday = getMondayOfISOWeek(year, week);
        weekInfo = { year, week, monday: approxMonday };
        console.log('[排班辅助] 从picker检测周:', year, '年 第', week, '周');
        return;
      }
    }

    // Fallback: URL参数
    const urlParams = new URLSearchParams(window.location.search);
    const dp = urlParams.get('date') || urlParams.get('from') || urlParams.get('startDate');
    if (dp) { weekInfo = getWeekInfo(new Date(dp)); return; }

    // Fallback: 页面文本
    const els = document.querySelectorAll('[class*="date"], [class*="week"], [class*="picker"]');
    for (let el of els) {
      const m = (el.textContent || '').match(/(\d{4})[年\-\/](\d{1,2})[月\-\/](\d{1,2})/);
      if (m) { weekInfo = getWeekInfo(new Date(+m[1], +m[2] - 1, +m[3])); return; }
    }
    if (!weekInfo.monday) weekInfo = getWeekInfo(new Date());
  }

  /**
   * 将 Date 对象格式化为 YYYY-MM-DD（本地时间，避免 UTC+8 偏移导致日期差一天）
   */
  function fmtLocalDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /**
   * ISO 8601: 根据年份和周数计算周一日期
   *   第1周 = 包含该年第一个周四的周
   */
  function getMondayOfISOWeek(year, week) {
    const jan4 = new Date(year, 0, 4);
    const jan4Dow = jan4.getDay() || 7; // 周日→7
    const week1Mon = new Date(jan4);
    week1Mon.setDate(jan4.getDate() - (jan4Dow - 1));
    const monday = new Date(week1Mon);
    monday.setDate(week1Mon.getDate() + (week - 1) * 7);
    return fmtLocalDate(monday);
  }

  /**
   * ISO 8601: 根据任意日期计算 [ISO年份, 周数, 周一日期]
   *   与 getMondayOfISOWeek 互为逆运算
   */
  function getWeekInfo(date) {
    const d = new Date(date);
    // 1. 找到该日期所在周的周一
    const dow = d.getDay();
    const offset = dow === 0 ? -6 : 1 - dow;
    const mon = new Date(d);
    mon.setDate(d.getDate() + offset);
    // 2. ISO 年份 = 该周周四所在的年份
    const thu = new Date(mon);
    thu.setDate(mon.getDate() + 3);
    const isoYear = thu.getFullYear();
    // 3. 计算 ISO 第1周的周一
    const jan4 = new Date(isoYear, 0, 4);
    const jan4Dow = jan4.getDay() || 7;
    const week1Mon = new Date(jan4);
    week1Mon.setDate(jan4.getDate() - (jan4Dow - 1));
    // 4. 周数 = 相差天数 / 7 + 1
    const diffMs = mon - week1Mon;
    const diffDays = Math.round(diffMs / 86400000);
    const wn = Math.floor(diffDays / 7) + 1;
    console.log('[排班辅助][getWeekInfo] 输入:', date,
      '→ mon:', fmtLocalDate(mon),
      'thu:', fmtLocalDate(thu), 'isoYear:', isoYear,
      'week1Mon:', fmtLocalDate(week1Mon),
      'diffMs:', diffMs, 'diffDays:', diffDays, 'wn:', wn);
    return { year: isoYear, week: wn, monday: fmtLocalDate(mon) };
  }
  function getSunday(ms) { const d = new Date(ms); d.setDate(d.getDate() + 6); return fmtLocalDate(d); }

  // ==================== 数据加载 ====================
  async function refreshAllData() {
    try {
      // --- 1. 加载班型 ---
      const cr = await ScheduleAPI.fetchClasses();
      console.log('[排班辅助] fetchClasses 原始响应类型:', typeof cr.data, Array.isArray(cr.data) ? '(数组,长度' + cr.data.length + ')' : '(对象,keys=' + Object.keys(cr.data || {}).join(',') + ')');
      if (!cr.error && cr.data) {
        const cls = Array.isArray(cr.data) ? cr.data : (cr.data.rows || cr.data.list || []);
        console.log('[排班辅助] 班型提取路径:', Array.isArray(cr.data) ? 'data直接是数组' : cr.data.rows ? 'data.rows' : 'data.list/空');
        classMap = {}; classIdMap = {};
        if (cls.length > 0) {
          console.log('[排班辅助] 第一条班型全部字段:', JSON.stringify(cls[0]));
          console.log('[排班辅助] 班型字段名:', Object.keys(cls[0]).join(', '));
        }
        cls.forEach(c => { const n = c.className || c.name || ''; const id = c.id || c.classId || ''; if (n && id) { classMap[n] = String(id); classIdMap[String(id)] = n; } });
        console.log('[排班辅助] 加载班型:', Object.keys(classMap).length, '种, 前5个:', JSON.stringify(Object.keys(classMap).slice(0, 5)));
        console.log('[排班辅助] classIdMap前5个key:', Object.keys(classIdMap).slice(0, 5));
      } else {
        console.warn('[排班辅助] 获取班型失败:', cr.message || cr.error);
      }

      // --- 2. 加载院区 ---
      const lr = await ScheduleAPI.fetchLocations();
      if (!lr.error && lr.data) {
        const locs = Array.isArray(lr.data) ? lr.data : (lr.data.rows || lr.data.list || []);
        if (locs.length) { locationId = String(locs[0].id || locs[0].locationId || ''); }
      }

      // --- 3. 加载员工 ---
      const er = await ScheduleAPI.fetchEmployees({ from: weekInfo.monday, to: getSunday(weekInfo.monday) });
      console.log('[排班辅助] fetchEmployees 原始响应类型:', typeof er.data, er.data && !Array.isArray(er.data) ? '(对象,keys=' + Object.keys(er.data).join(',') + ')' : '');
      if (!er.error && er.data) {
        const emps = Array.isArray(er.data) ? er.data : (er.data.rows || er.data.list || []);
        console.log('[排班辅助] 员工提取路径:', Array.isArray(er.data) ? 'data直接是数组' : er.data.rows ? 'data.rows' : 'data.list/空', ', 共', emps.length, '条');
        state.doctors = ScheduleAPI.buildDoctorsFromAPI(emps);
        console.log('[排班辅助] 加载员工:', emps.length, '→ 过滤后', state.doctors.length, '人');
      } else {
        console.warn('[排班辅助] 获取员工失败:', er.message || er.error);
      }

      // --- 4. 加载排班数据 ---
      if (state.doctors.length) {
        const empIds = state.doctors.map(d => d.id);
        const sr = await ScheduleAPI.fetchEmpSchedules({ empIds: empIds, from: weekInfo.monday, to: getSunday(weekInfo.monday) });
        console.log('[排班辅助] empSchedules 原始响应类型:', typeof sr.data, sr.data && !Array.isArray(sr.data) ? '(对象,keys=' + Object.keys(sr.data).join(',') + ')' : '');
        // ---------- 输出周一所有医生的排班原始数据 ----------
        if (!sr.error && sr.data) {
          var scheds = Array.isArray(sr.data) ? sr.data : (sr.data.employees || sr.data.data || sr.data.rows || sr.data.list || []);
          var monDate = weekInfo.monday;
          var mondayScheds = scheds.filter(function (r) {
            var wd = (r.workDate || r.date || '').slice(0, 10);
            return wd === monDate;
          });
          console.log('[排班辅助] 📅 周一(' + monDate + ') 原始排班数据 (' + mondayScheds.length + '条):');
          mondayScheds.forEach(function (r, i) {
            console.log('  [' + (i + 1) + ']', JSON.parse(JSON.stringify(r)));
          });
        }
        // ----------------------------------------------------
        if (!sr.error && sr.data) {
          parseSchedulesFromAPI(sr.data);
          console.log('[排班辅助] 加载排班: 门诊' + Object.values(state.outpatientGeneral).filter(g => g.am || g.pm).length +
            '条, 值班' + Object.keys(state.dutyAssigned).length + '人, 特殊' + Object.keys(state.special).length + '人');
        }
      }

      // --- 5. 上周门诊预置（改为手动触发，不再自动加载） ---
      // 用户可在 S2 步骤点击"导入上周门诊"按钮手动加载

      if (!state.dutyOrder || state.dutyOrder.length !== 8) {
        state.dutyOrder = A.buildDefaultDutyOrder(state.doctors);
      }
    } catch (err) {
      console.error('[排班辅助] 数据刷新异常:', err.message);
    }
  }

  function parseSchedulesFromAPI(data) {
    console.log('[排班辅助] parseSchedulesFromAPI: 输入数据类型=' + (Array.isArray(data) ? 'array' : typeof data) +
      ', keys=' + (data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data).join(',') : 'N/A'));

    const scheds = Array.isArray(data) ? data : (data.employees || data.data || data.rows || data.list || []);
    console.log('[排班辅助] scheds路径: ' + (Array.isArray(data) ? 'data直接是数组' : data.employees ? 'data.employees' : data.data ? 'data.data' : data.rows ? 'data.rows' : 'data.list/空'));
    console.log('[排班辅助] 排班原始记录数:', scheds.length, '| classIdMap大小:', Object.keys(classIdMap).length);

    if (scheds.length > 0) {
      console.log('[排班辅助] 第一条排班全部字段:', JSON.stringify(scheds[0]));
      // 打印前3条的关键字段
      for (var si = 0; si < Math.min(3, scheds.length); si++) {
        var sr = scheds[si];
        console.log('[排班辅助] 排班#' + si + ' 关键字段:', JSON.stringify({
          empId: sr.empId,
          workDate: sr.workDate,
          segment: sr.segment,
          id: sr.id,
          name: sr.name,
          classId: sr.classId,
          className: sr.className,
          scheduleClassId: sr.scheduleClassId
        }));
      }
    }

    state.outpatientGeneral = {}; state.dutyAssigned = {}; state.special = {};
    state.outpatientSimple = []; state.outpatientGaoxin = []; state.outpatientZitong = [];
    for (let d = 0; d < 7; d++) state.outpatientGeneral[d] = { am: null, pm: null };
    const m = new Date(weekInfo.monday); const d2i = {};
    for (let d = 0; d < 7; d++) { const dt = new Date(m); dt.setDate(m.getDate() + d); d2i[fmtLocalDate(dt)] = d; }
    console.log('[排班辅助] 日期映射(d2i):', JSON.stringify(d2i));

    var skippedNoEid = 0, skippedNoCn = 0, skippedNoDate = 0, parsedOk = 0;
    var cnMismatchSamples = []; // 记录classIdMap找不到的样本
    for (let r of scheds) {
      const eid = String(r.empId || r.employeeId || ''), wd = (r.workDate || r.date || '').slice(0, 10);
      const rawId = r.classId || r.scheduleClassId || '';
      const classIdKey = String(rawId);
      const fromMap = classIdMap[classIdKey];
      const cn = fromMap || r.name || r.className || '';
      const di = d2i[wd];

      // 记录前5条找不到的
      if (!fromMap && cnMismatchSamples.length < 5 && rawId) {
        cnMismatchSamples.push({ rawId: rawId, className: r.name || r.className, fromMap: fromMap });
      }

      if (!eid) { skippedNoEid++; continue; }
      if (!cn) { skippedNoCn++; continue; }
      if (di === undefined) { skippedNoDate++; continue; }
      parsedOk++;
      const sl = r.segment ? (r.segment === 1 ? 'am' : 'pm') : (r.slot || r.ampm || r.timeSlot || 'am');
      // amount>=1 表示全天班（如脱产学习），需同时写入上午和下午
      const applySlots = (r.amount >= 1) ? ['am', 'pm'] : [sl];
      for (var si = 0; si < applySlots.length; si++) {
        var curSlot = applySlots[si];
        if (A.CLINIC_TYPES.includes(cn)) {
          if (cn === '总院门诊') {
            if (!state.outpatientGeneral[di]) state.outpatientGeneral[di] = { am: null, pm: null };
            if (state.outpatientGeneral[di][curSlot] && state.outpatientGeneral[di][curSlot] !== eid) {
              // 该时段已有其他医生的总院门诊 → 当前这条转为简易门诊
              if (!state.outpatientSimple) state.outpatientSimple = [];
              if (!state.outpatientSimple.find(function (a) { return a.dayIdx === di && a.slot === curSlot && a.doctorId === eid; })) {
                state.outpatientSimple.push({ dayIdx: di, slot: curSlot, doctorId: eid });
                var doc1 = getDoctor(state.outpatientGeneral[di][curSlot]);
                var doc2 = getDoctor(eid);
                console.log('[排班辅助] ⚠️ ' + A.DAYS[di] + A.SLOT_LABELS[curSlot] +
                  ' 存在两个总院门诊: ' + (doc1 ? doc1.name : state.outpatientGeneral[di][curSlot]) +
                  '(保留) / ' + (doc2 ? doc2.name : eid) + '(→简易门诊)');
              }
            } else {
              state.outpatientGeneral[di][curSlot] = eid;
            }
          }
          else if (cn === '高新门诊') { if (!state.outpatientGaoxin.find(a => a.dayIdx === di && a.doctorId === eid)) state.outpatientGaoxin.push({ dayIdx: di, doctorId: eid }); }
          else if (cn === '梓潼门诊') { if (!state.outpatientZitong.find(a => a.dayIdx === di && a.doctorId === eid)) state.outpatientZitong.push({ dayIdx: di, doctorId: eid }); }
        } else if (A.SPECIAL_TYPES.includes(cn)) {
          if (!state.special[eid]) state.special[eid] = {}; if (!state.special[eid][di]) state.special[eid][di] = { am: null, pm: null };
          state.special[eid][di][curSlot] = cn;
        } else {
          if (!state.dutyAssigned[eid]) state.dutyAssigned[eid] = {}; if (!state.dutyAssigned[eid][di]) state.dutyAssigned[eid][di] = { am: null, pm: null };
          state.dutyAssigned[eid][di][curSlot] = cn;
        }
      }
    }
    console.log('[排班辅助] 解析结果: 成功=' + parsedOk + ' 缺员工=' + skippedNoEid + ' 缺班型=' + skippedNoCn + ' 缺日期=' + skippedNoDate);
    if (cnMismatchSamples.length > 0) {
      console.log('[排班辅助] classIdMap未命中样本(前5条):', JSON.stringify(cnMismatchSamples));
      console.log('[排班辅助] classIdMap已有key样本(前10个):', Object.keys(classIdMap).slice(0, 10));
    }
  }

  async function loadPrevWeekData() {
    // 尝试从 background 缓存加载
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'GET_PREV_WEEK_DATA' });
      if (resp && resp.success && resp.data) {
        applyPrevWeekData(resp.data);
        return;
      }
    } catch (e) { /* ignore */ }

    // 缓存未命中，从 API 直接拉取上周排班
    const eids = state.doctors.map(d => d.id);
    if (!eids.length) return;

    const pm = new Date(weekInfo.monday);
    pm.setDate(pm.getDate() - 7);
    const pms = fmtLocalDate(pm);
    const pme = getSunday(pms);

    try {
      const sr = await ScheduleAPI.fetchEmpSchedules({ empIds: eids, from: pms, to: pme });
      if (!sr.error && sr.data) {
        const scheds = Array.isArray(sr.data) ? sr.data : (sr.data.employees || sr.data.data || sr.data.rows || sr.data.list || []);
        // 保存到 background 缓存供下次使用
        chrome.runtime.sendMessage({ type: 'SAVE_PREV_WEEK_DATA', data: { monday: pms, schedules: scheds } });
        // 直接解析并应用
        applyPrevWeekData({ monday: pms, schedules: scheds });
      }
    } catch (e) { /* ignore */ }
  }

  function applyPrevWeekData(prevData) {
    if (!prevData || !prevData.schedules || !prevData.schedules.length) return;

    const scheds = prevData.schedules;
    const m = new Date(prevData.monday);
    const d2i = {};
    for (let d = 0; d < 7; d++) {
      const dt = new Date(m);
      dt.setDate(m.getDate() + d);
      d2i[fmtLocalDate(dt)] = d;
    }

    let outGeneralCount = 0, outGaoxinCount = 0, outZitongCount = 0;
    let dutyCount = 0;

    for (let r of scheds) {
      const eid = String(r.empId || r.employeeId || '');
      const wd = (r.workDate || r.date || '').slice(0, 10);
      const cn = classIdMap[String(r.classId || r.scheduleClassId || '')] || r.name || r.className || '';
      const di = d2i[wd];
      if (di === undefined || !eid || !cn) continue;

      const sl = r.segment ? (r.segment === 1 ? 'am' : 'pm') : (r.slot || r.ampm || r.timeSlot || 'am');
      const applySlots = (r.amount >= 1) ? ['am', 'pm'] : [sl];

      // 检查当前周是否有同名医生（ID匹配）
      const docExists = state.doctors.some(d => d.id === eid);
      if (!docExists) continue;

      // 门诊数据预置
      for (var si2 = 0; si2 < applySlots.length; si2++) {
        var curSlot2 = applySlots[si2];
        if (cn === '总院门诊') {
          if (!state.outpatientGeneral[di]) state.outpatientGeneral[di] = { am: null, pm: null };
          if (!state.outpatientGeneral[di][curSlot2]) {
            state.outpatientGeneral[di][curSlot2] = eid;
            outGeneralCount++;
          } else if (state.outpatientGeneral[di][curSlot2] !== eid) {
            // 该时段已有其他医生的总院门诊 → 当前转为简易门诊
            if (!state.outpatientSimple) state.outpatientSimple = [];
            if (!state.outpatientSimple.find(function (a) { return a.dayIdx === di && a.slot === curSlot2 && a.doctorId === eid; })) {
              state.outpatientSimple.push({ dayIdx: di, slot: curSlot2, doctorId: eid });
            }
          }
        } else if (cn === '高新门诊') {
          if (!state.outpatientGaoxin.find(a => a.dayIdx === di && a.doctorId === eid)) {
            state.outpatientGaoxin.push({ dayIdx: di, doctorId: eid });
            outGaoxinCount++;
          }
        } else if (cn === '梓潼门诊') {
          if (!state.outpatientZitong.find(a => a.dayIdx === di && a.doctorId === eid)) {
            state.outpatientZitong.push({ dayIdx: di, doctorId: eid });
            outZitongCount++;
          }
        }

        // 值班数据预置（中班/值班/夜休）
        if (cn === '值班' || cn === '中班' || cn === '夜休') {
          if (!state.dutyAssigned[eid]) state.dutyAssigned[eid] = {};
          if (!state.dutyAssigned[eid][di]) state.dutyAssigned[eid][di] = { am: null, pm: null };
          const genDay = state.outpatientGeneral[di] || { am: null, pm: null };
          if (!genDay[curSlot2] || genDay[curSlot2] !== eid) {
            state.dutyAssigned[eid][di][curSlot2] = cn;
            dutyCount++;
          }
        }
      }
    }

    const total = outGeneralCount + outGaoxinCount + outZitongCount + dutyCount;
    if (total > 0) {
      console.log('[排班辅助] 📥 已从上周预置: 总院门诊×' + outGeneralCount +
        ' 高新门诊×' + outGaoxinCount + ' 梓潼门诊×' + outZitongCount +
        ' 值班×' + dutyCount);
    }
  }

  // ==================== 恢复原始数据 ====================
  async function restoreOriginalData() {
    if (!originalData) { showToast('没有可恢复的备份数据', 'warn'); return; }
    if (!(await showModal({ title: '确认恢复', message: '确定恢复为操作前的原始数据？', icon: 'warning_amber' }))) return;
    state.doctors = JSON.parse(JSON.stringify(originalData.doctors || []));
    state.outpatientGeneral = JSON.parse(JSON.stringify(originalData.outpatientGeneral || {}));
    state.outpatientSimple = JSON.parse(JSON.stringify(originalData.outpatientSimple || []));
    state.outpatientGaoxin = JSON.parse(JSON.stringify(originalData.outpatientGaoxin || []));
    state.outpatientZitong = JSON.parse(JSON.stringify(originalData.outpatientZitong || []));
    state.special = JSON.parse(JSON.stringify(originalData.special || {}));
    state.dutyAssigned = JSON.parse(JSON.stringify(originalData.dutyAssigned || {}));
    state.workdayConfig = JSON.parse(JSON.stringify(originalData.workdayConfig || [true, true, true, true, true, false, false]));
    state.baiban1Flags = []; state.dutyOrder = A.buildDefaultDutyOrder(state.doctors);
    renderPanel(); showToast('已恢复原始数据', 'success');
  }

  function syncStateToBackground() {
    chrome.runtime.sendMessage({ type: 'UPDATE_SCHEDULE_STATE', scheduleState: { doctors: state.doctors, workdayConfig: state.workdayConfig, outpatientGeneral: state.outpatientGeneral, outpatientSimple: state.outpatientSimple, outpatientGaoxin: state.outpatientGaoxin, outpatientZitong: state.outpatientZitong, special: state.special, dutyAssigned: state.dutyAssigned, dutyOrder: state.dutyOrder } });
    chrome.runtime.sendMessage({ type: 'UPDATE_CLASS_MAP', classMap }); chrome.runtime.sendMessage({ type: 'UPDATE_LOCATION', locationId });
  }

  // ==================== 色条 ====================
  function applyClassColorBar(cell, st) { const o = cell.querySelector('.sh-class-color-bar'); if (o) o.remove(); if (!st) return; const c = A.TYPE_COLORS[st]; if (!c) return; cell.style.position = cell.style.position || 'relative'; const b = document.createElement('div'); b.className = 'sh-class-color-bar'; b.style.background = c; cell.appendChild(b); }
  function removeClassColorBars() { document.querySelectorAll('.sh-class-color-bar').forEach(b => b.remove()); }
  // 缓存：页面系统中表示"空白"的 CSS Module 类名（如 noClass___1hbgr），首次遇到时自动探测
  let _noClassClsCache = null;

  function applyToPageTable(styleOnly) {
    styleOnly = styleOnly || false;
    // styleOnly=true → 只改样式不改文本（手动编辑后被动刷新）
    // styleOnly=false → 改文本+样式（插件主动渲染）
    const tbody = document.querySelector('.ant-table-tbody');
    if (!tbody) { console.log('[排班辅助] ⚠️ 未找到页面排班表格'); return 0; }

    const rows = tbody.querySelectorAll('tr.ant-table-row');
    if (!rows.length) { console.log('[排班辅助] ⚠️ 表格无数据行'); return 0; }

    // 构建 工号(院内工号) → row 映射
    const rowMap = {};
    let cellsPerDay = 1; // 1=单格模式, 2=两端排班模式
    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      if (cells.length < 15) continue;
      const empNumber = cells[7].textContent.trim();
      if (empNumber) rowMap[empNumber] = { row, cells };
      // 检测模式：两端排班每天两列（班次1+班次2），单格模式每天一列
      if (cellsPerDay === 1 && cells.length >= 24) cellsPerDay = 2;
    }

    console.log('[排班辅助] 表格模式: ' + (cellsPerDay === 2 ? '两端排班(每天2列)' : '单格(每天1列)'));

    // 根据 styleOnly 选择策略：true=只改样式不改文本，false=改文本+样式
    function _apply(div, type) {
      if (styleOnly) { applyStyleByDomText(div); }
      else if (type) { applyClassDivStyle(div, type); }
      else { resetClassDiv(div); }
    }

    let updatedCount = 0, skippedCount = 0;

    for (const doc of state.doctors) {
      const docNum = String(doc.number);
      const entry = rowMap[docNum];
      if (!entry) { skippedCount++; continue; }

      const { cells } = entry;
      for (let d = 0; d < 7; d++) {
        if (cellsPerDay === 2) {
          // ===== 两端排班模式：每天两列 =====
          const amCell = cells[8 + d * 2];      // 班次1 = 上午
          const pmCell = cells[8 + d * 2 + 1];   // 班次2 = 下午
          if (!amCell || !pmCell) continue;

          const amDiv = amCell.querySelector('[class*="tooltip"] > div');
          const pmDiv = pmCell.querySelector('[class*="tooltip"] > div');
          if (!amDiv || !pmDiv) continue;

          // 探测空白类名
          if (!_noClassClsCache) detectNoClass(amDiv);

          const amType = A.getSlotSchedule(state, doc.id, d, 'am');
          const pmType = A.getSlotSchedule(state, doc.id, d, 'pm');

          _apply(amDiv, amType);
          _apply(pmDiv, pmType);

          if (amType || pmType) updatedCount++;
        } else {
          // ===== 单格模式：每天一列 =====
          const cell = cells[8 + d];
          if (!cell) continue;

          const classDivs = cell.querySelectorAll('[class*="tooltip"] > div');
          if (classDivs.length === 0) continue;

          if (!_noClassClsCache) detectNoClass(classDivs[0]);

          const amType = A.getSlotSchedule(state, doc.id, d, 'am');
          const pmType = A.getSlotSchedule(state, doc.id, d, 'pm');

          if (classDivs.length === 1) {
            // 全天班（amount=1）：只有一个 tooltip，如"脱产学习"
            const onlyDiv = classDivs[0];
            if (amType || pmType) {
              _apply(onlyDiv, amType || pmType);
              updatedCount++;
            } else {
              _apply(onlyDiv, null);
            }
          } else {
            // 半天班（两个0.5）：两个 tooltip，分别对应上午/下午
            const amDiv = classDivs[0];
            const pmDiv = classDivs[1];

            if (!amType && !pmType) {
              _apply(amDiv, null); _apply(pmDiv, null);
              continue;
            }

            _apply(amDiv, amType);
            _apply(pmDiv, pmType);

            if (amType || pmType) updatedCount++;
          }
        }
      }
    }

    console.log('[排班辅助] 🎨 页面表格更新: ' + updatedCount + ' 个单元格, 跳过 ' + skippedCount + ' 人(不在表中)');
    return updatedCount;
  }

  /** 探测 noClass___xxxx 空白类名 */
  function detectNoClass(sampleDiv) {
    const found = Array.from(sampleDiv.classList).find(function (c) { return c.indexOf('noClass') === 0 || c.indexOf('NoClass') === 0; });
    if (found) { _noClassClsCache = found; console.log('[排班辅助] 🔍 探测到空白类名:', _noClassClsCache); }
  }

  /** 安全更新 div 文本，保留子元素（避免 React 崩溃） */
  function setDivText(div, text) {
    if (!div) return;
    var textNode = null;
    for (var i = 0; i < div.childNodes.length; i++) {
      if (div.childNodes[i].nodeType === 3) { textNode = div.childNodes[i]; break; }
    }
    if (textNode) {
      textNode.nodeValue = text;
    } else {
      div.insertBefore(document.createTextNode(text), div.firstChild);
    }
  }

  /** 隐藏 div 内的子元素（如红色下划线），但不删除 DOM 节点 */
  function hideChildElements(div) {
    if (!div) return;
    for (var i = 0; i < div.children.length; i++) {
      div.children[i].style.display = 'none';
    }
  }

  /** 重置单个班型格为空白状态 */
  function resetClassDiv(div) {
    if (!div) return;
    div.style.cssText = '';
    setDivText(div, '\u00A0');
    hideChildElements(div);
    if (_noClassClsCache) div.classList.add(_noClassClsCache);
  }

  /** 给单个班型格应用班型样式 */
  function applyClassDivStyle(div, typeName) {
    if (!div) return;
    if (_noClassClsCache) div.classList.remove(_noClassClsCache);
    setDivText(div, typeName);
    hideChildElements(div);
    const c = A.TYPE_COLORS[typeName];
    if (c) {
      div.style.backgroundColor = c + '22';
      div.style.color = c;
      div.style.fontWeight = '600';
      div.style.padding = '2px 6px';
      div.style.borderRadius = '4px';
      div.style.fontSize = '14px';
      div.style.borderLeft = '3px solid ' + c;
    }
  }

  /** 仅根据 DOM 中已有文本应用样式（不修改文本），用于手动编辑后的被动刷新 */
  function applyStyleByDomText(div) {
    if (!div) return;
    var text = div.textContent.trim();
    if (!text || text === '\u00A0') {
      div.style.cssText = '';
      if (_noClassClsCache) div.classList.add(_noClassClsCache);
    } else {
      if (_noClassClsCache) div.classList.remove(_noClassClsCache);
      var c = A.TYPE_COLORS[text];
      if (c) {
        div.style.cssText = '';
        div.style.backgroundColor = c + '22';
        div.style.color = c;
        div.style.fontWeight = '600';
        div.style.padding = '2px 6px';
        div.style.borderRadius = '4px';
        div.style.fontSize = '14px';
        div.style.borderLeft = '3px solid ' + c;
      }
    }
    hideChildElements(div);
  }

  /** 清除页面表格中插件添加的所有样式和内容 */
  function clearPageTableCells() {
    const tbody = document.querySelector('.ant-table-tbody');
    if (!tbody) return;
    const classDivs = tbody.querySelectorAll('[class*="tooltip"] > div');
    classDivs.forEach(div => resetClassDiv(div));
    removeClassColorBars();
    console.log('[排班辅助] 🧹 页面表格已清除');
  }

  // ==================== 常用班次标签配色 ====================

  /** 给"常用班次"区域的班型标签应用 TYPE_COLORS 配色 */
  function applyClassBadgeColors() {
    // 找到"常用班次"Tab面板：id 格式如 rc-tabs-1-panel-常用班次
    const panel = document.querySelector('[id*="-panel-"][id*="常用班次"]');
    if (!panel) { console.log('[排班辅助] ⚠️ 未找到常用班次面板'); return; }

    // 每个标签：.ant-space-item > div（第一个 div 就是班型名容器）
    const items = panel.querySelectorAll('.ant-space-item');
    if (!items.length) return;

    let count = 0;
    items.forEach(function (item) {
      const badge = item.querySelector('div');
      if (!badge) return;
      const name = badge.textContent.trim();
      const color = A.TYPE_COLORS[name];
      if (!color) return;

      // 应用颜色
      badge.style.backgroundColor = color;
      badge.style.color = '#fff';
      badge.style.fontWeight = '600';
      badge.style.padding = '4px 12px';
      badge.style.borderRadius = '6px';
      badge.style.fontSize = '13px';
      badge.style.display = 'inline-block';
      badge.style.cursor = 'pointer';
      count++;
    });

    console.log('[排班辅助] 🏷️ 常用班次标签配色: ' + count + ' 个');
  }

  /** 清除常用班次标签的插件样式 */
  function clearClassBadgeColors() {
    const panel = document.querySelector('[id*="-panel-"][id*="常用班次"]');
    if (!panel) return;
    const items = panel.querySelectorAll('.ant-space-item');
    items.forEach(function (item) {
      const badge = item.querySelector('div');
      if (!badge) return;
      badge.style.cssText = '';
    });
  }

  // ==================== 自动刷新样式（监听页面变化） ====================

  var _tableObserver = null;
  var _refreshTimer = null;
  var _refreshing = false;       // 防重入

  /** 主动刷新表格样式 + 班型标签 */
  function _scheduleRefreshDisplay() {
    if (_refreshTimer) clearTimeout(_refreshTimer);
    _refreshTimer = setTimeout(function () {
      _refreshTimer = null;
      if (_refreshing) return;
      _refreshing = true;
      try {
        _noClassClsCache = null;
        applyToPageTable(true);
        applyClassBadgeColors();
      } finally {
        _refreshing = false;
      }
      // 二次检查：医院系统可能分批渲染（先AM后PM），300ms后再补一次
      setTimeout(function () {
        if (_refreshing) return;
        _refreshing = true;
        try { applyToPageTable(true); } finally { _refreshing = false; }
      }, 300);
    }, 500);
  }

  /** 启动所有主动监听 */
  function setupTableWatcher() {
    // ---- MutationObserver：监听表格结构变化（切换周数 / 开关两端排班都会重渲染tbody） ----
    var tableContainer = document.querySelector('.ant-table-container');
    if (tableContainer && !_tableObserver) {
      _tableObserver = new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var m = mutations[i];
          // 任何元素节点的添加都触发（TR=整行重渲染, DIV=PM时段延迟加载到已有单元格内）
          if (m.type === 'childList' && m.addedNodes.length > 0) {
            for (var k = 0; k < m.addedNodes.length; k++) {
              if (m.addedNodes[k].nodeType === 1) {
                _scheduleRefreshDisplay();
                return;
              }
            }
          }
        }
      });
      _tableObserver.observe(tableContainer, {
        childList: true,
        subtree: true
      });
      console.log('[排班辅助] 👁️ 表格变化监听已启动（切换周数 / 两端排班）');
    }

    // ---- 监听"两端排班"复选框（兜底：某些情况下 MutationObserver 可能不触发） ----
    var allLabels = document.querySelectorAll('.ant-checkbox-wrapper');
    for (var j = 0; j < allLabels.length; j++) {
      var label = allLabels[j];
      if (label.textContent.indexOf('两端排班') !== -1 || label.textContent.indexOf('两端') !== -1) {
        label.addEventListener('click', function () {
          setTimeout(function () { _scheduleRefreshDisplay(); }, 350);
        });
        console.log('[排班辅助] 👁️ 两端排班开关监听已绑定');
        break;
      }
    }
  }
  /** 停止所有主动监听 */
  function teardownTableWatcher() {
    if (_tableObserver) { _tableObserver.disconnect(); _tableObserver = null; }
    if (_refreshTimer) { clearTimeout(_refreshTimer); _refreshTimer = null; }
  }

  // ==================== 提交 ====================
  async function submitAllChanges() {
    if (!(await showModal({ title: '确认提交', message: '确定提交所有排班修改？\n提交成功后请刷新页面查看。', icon: 'file_upload' }))) return;
    try {
      const bd = ScheduleAPI.buildBatchData(state, classMap, locationId, weekInfo.monday);
      console.log('[排班辅助] 📤 提交数据 (' + bd.length + '条):', JSON.stringify(bd.slice(0, 3)) + (bd.length > 3 ? '...' : ''));
      if (!bd.length) { showToast('没有需要提交的修改', 'warn'); return; }
      const resp = await ScheduleAPI.appendUsualClass(bd);
      if (resp.error) { showToast('提交失败: ' + (resp.message || '未知错误'), 'error'); return; }
      showToast(`成功提交 ${bd.length} 条排班记录！请刷新页面查看。`, 'success');
      if (restoreFetch) { restoreFetch(); restoreFetch = null; }
      chrome.runtime.sendMessage({ type: 'SET_INTERCEPTING', intercepting: false });
      setTimeout(async () => { if (await showModal({ title: '提交成功', message: '排班已提交成功，是否刷新页面？', icon: 'check_circle', cancelLabel: '稍后' })) window.location.reload(); }, 1500);
    } catch (err) { showToast('提交异常: ' + err.message, 'error'); }
  }

  // ==================== DOM 注入 ====================
  function injectQuickEntry() {
    if (document.getElementById('sh-quick-entry')) return;
    const e = document.createElement('div'); e.id = 'sh-quick-entry'; e.className = 'hidden'; e.textContent = '排班辅助'; e.title = '点击打开排班辅助面板';
    e.addEventListener('click', () => togglePanel(true));
    e.addEventListener('contextmenu', (ev) => ev.preventDefault());
    e.addEventListener('selectstart', (ev) => ev.preventDefault());
    e.addEventListener('copy', (ev) => ev.preventDefault());
    document.body.appendChild(e);
  }
  function injectToastContainer() {
    if (document.getElementById('sh-toast-container')) return;
    const c = document.createElement('div'); c.id = 'sh-toast-container'; c.className = 'sh-toast-container'; document.body.appendChild(c);
  }
  function injectPanel() {
    if (document.getElementById('scheduling-helper-panel')) return;
    // 注入 Material Icons 样式（本地字体文件）
    if (!document.getElementById('__sh-material-icons')) {
      const style = document.createElement('style');
      style.id = '__sh-material-icons';
      style.textContent = `@font-face{font-family:'Material Icons';font-style:normal;font-weight:400;src:url(${chrome.runtime.getURL('icons/MaterialIcons-Regular.woff2')}) format('woff2');}.material-icons{font-family:'Material Icons';font-weight:400;font-style:normal;display:inline-block;line-height:1;text-transform:none;letter-spacing:normal;word-wrap:normal;white-space:nowrap;direction:ltr;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;-moz-osx-font-smoothing:grayscale;font-feature-settings:'liga';}`;
      document.head.appendChild(style);
    }
    const p = document.createElement('div'); p.id = 'scheduling-helper-panel';
    p.addEventListener('contextmenu', (ev) => ev.preventDefault());
    p.innerHTML = `<div class="sh-panel-header" id="sh-panel-header"><span class="sh-title"><span class="material-icons">local_hospital</span> 排班辅助</span><div class="sh-actions"><button class="sh-btn" id="sh-btn-minimize" title="最小化">−</button><button class="sh-btn" id="sh-btn-close" title="关闭">✕</button></div></div><div class="sh-steps-bar" id="sh-steps-bar"><div class="sh-step-item active" data-action="goToStep" data-step="1"><span class="sh-step-num">1</span>人员</div><div class="sh-step-item" data-action="goToStep" data-step="2"><span class="sh-step-num">2</span>门诊</div><div class="sh-step-item" data-action="goToStep" data-step="3"><span class="sh-step-num">3</span>特殊</div><div class="sh-step-item" data-action="goToStep" data-step="4"><span class="sh-step-num">4</span>值班</div><div class="sh-step-item" data-action="goToStep" data-step="5"><span class="sh-step-num">5</span>确认</div></div><div class="sh-panel-body" id="sh-panel-body"></div>`;
    document.body.appendChild(p);
    makeDraggable(p.querySelector('.sh-panel-header'), p);
    document.getElementById('sh-btn-minimize').addEventListener('click', toggleMinimize);
    document.getElementById('sh-btn-close').addEventListener('click', () => togglePanel(false));
    // 统一事件代理（避免 CSP 内联事件违规）
    setupPanelDelegation(p);
  }

  // ==================== 事件代理：绑定到整个 panel（包括步骤条和body） ====================
  function setupPanelDelegation(panel) {
    // click 代理 — 绑在整个 panel 上，覆盖步骤条 + body 区域
    panel.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]'); if (!el) return;
      const action = el.dataset.action; const ds = el.dataset;
      switch (action) {
        case 'goToStep': goToStep(+ds.step); break;
        case 'toggleWorkday': toggleWorkday(+ds.day); break;
        case 'addGaoxin': addGaoxin(); break;
        case 'removeGaoxin': removeGaoxin(+ds.idx); break;
        case 'addZitong': addZitong(); break;
        case 'removeZitong': removeZitong(+ds.idx); break;
        case 'addSimple': addSimple(); break;
        case 'removeSimple': removeSimple(+ds.idx); break;
        case 'exportOutpatient': exportOutpatientJSON(); break;
        case 'importOutpatient': importOutpatientJSON(); break;
        case 'clearOutpatient': clearOutpatient(); break;
        case 'renderSpecialForm': renderSpecialDocForm(); break;
        case 'toggleAllSpecial': toggleAllSpecial(ds.on === 'true', ds.doc); break;
        case 'toggleWorkdaySpecial': toggleWorkdaySpecial(ds.doc); break;
        case 'toggleSlotSpecial': toggleSlotSpecial(ds.doc, ds.slot); break;
        case 'batchSpecial': batchSpecial(ds.doc); break;
        case 'batchClearSpecial': batchClearSpecial(ds.doc); break;
        case 'resetDutyOrder': resetDutyOrder(); break;
        case 'runAutoDuty': runAutoDuty(); break;
        case 'clearDuty': clearDuty(); break;
        case 'quickBaiban1': quickBaiban1(+ds.day, ds.slot); break;
        case 'fillEmpty': fillEmpty(); break;
        case 'syncTrainees': syncTrainees(); break;
        case 'submitAll': submitAllChanges(); break;
        case 'exportFull': exportFullScheduleJSON(); break;
        case 'importFull': importFullScheduleJSON(); break;
        case 'confirmWeek': confirmWeekChange(); break;
        case 'goPrevWeek': goToPrevWeek(); break;
        case 'goNextWeek': goToNextWeek(); break;
        case 'fetchPrevWeekOutpatient': fetchAndPreviewPrevWeekOutpatient(); break;
        case 'applyPrevWeekOutpatient': applyPrevWeekOutpatient(); break;
        case 'clearPrevWeekPreview': clearPrevWeekPreview(); break;
        case 'fetchPrevWeekDuty': fetchAndPreviewPrevWeekDuty(); break;
        case 'applyPrevWeekDutyOrder': applyPrevWeekDutyOrder(); break;
        case 'clearPrevWeekDutyPreview': clearPrevWeekDutyPreview(); break;
      }
    });

    // change 代理 (select元素) — 同样绑在 panel 上
    panel.addEventListener('change', (e) => {
      const el = e.target.closest('[data-action]'); if (!el) return;
      const action = el.dataset.action; const ds = el.dataset; const val = el.value;
      switch (action) {
        case 'updateGeneral': updateGeneral(+ds.day, ds.slot, val); break;
        case 'updateGaoxin': updateGaoxin(+ds.idx, ds.field, ds.field === 'dayIdx' ? +val : val); break;
        case 'updateZitong': updateZitong(+ds.idx, ds.field, ds.field === 'dayIdx' ? +val : val); break;
        case 'updateSimple': updateSimple(+ds.idx, ds.field, ds.field === 'dayIdx' ? +val : val); break;
        case 'updateSpecial': updateSpecial(ds.doc, +ds.day, ds.slot, val); break;
        case 'updateDutyOrder': updateDutyOrder(+ds.idx, val); break;
        case 'updateMentor': updateMentor(ds.doc, val); break;
        case 'renderSpecialForm': renderSpecialDocForm(); break;
      }
    });

    // 拖拽代理 — 完整动画版（延时变淡 + 渐变边框指示）
    panel.addEventListener('dragstart', (e) => {
      const el = e.target.closest('[data-action="dutyDrag"]'); if (!el) return;
      dragSrcIdx = +el.dataset.idx;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragSrcIdx);
      // 延迟0.2s后将原位置变为更透明
      if (dragOpacityTimer) { clearTimeout(dragOpacityTimer); dragOpacityTimer = null; }
      dragOpacityTimer = setTimeout(() => {
        el.classList.add('drag-src-fading');
      }, 200);
    });

    panel.addEventListener('dragend', (e) => {
      // 清理所有拖拽视觉状态
      if (dragOpacityTimer) { clearTimeout(dragOpacityTimer); dragOpacityTimer = null; }
      panel.querySelectorAll('.sh-duty-row').forEach(r => {
        r.classList.remove('drag-src-fading', 'drag-insert-above', 'drag-insert-below');
        r.style.opacity = '';
      });
    });

    panel.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const row = e.target.closest('[data-action="dutyDrag"]');
      if (!row || dragSrcIdx === null) return;

      // 清除所有行的指示状态
      panel.querySelectorAll('.sh-duty-row').forEach(r => {
        r.classList.remove('drag-insert-above', 'drag-insert-below');
      });

      const targetIdx = +row.dataset.idx;
      if (isNaN(targetIdx)) return;

      // 根据拖拽方向显示插入指示
      if (dragSrcIdx > targetIdx) {
        // 向上拖：目标行上边框 + 上一行下边框 同时闪烁
        row.classList.add('drag-insert-above');
        const prevRow = panel.querySelector(`.sh-duty-row[data-idx="${targetIdx - 1}"]`);
        if (prevRow) prevRow.classList.add('drag-insert-below');
      } else if (dragSrcIdx < targetIdx) {
        // 向下拖：目标行下边框 + 下一行上边框 同时闪烁
        row.classList.add('drag-insert-below');
        const nextRow = panel.querySelector(`.sh-duty-row[data-idx="${targetIdx + 1}"]`);
        if (nextRow) nextRow.classList.add('drag-insert-above');
      }
    });

    panel.addEventListener('dragleave', (e) => {
      const row = e.target.closest('[data-action="dutyDrag"]');
      if (row && !row.contains(e.relatedTarget)) {
        row.classList.remove('drag-insert-above', 'drag-insert-below');
        const idx = +row.dataset.idx;
        if (!isNaN(idx)) {
          const prevRow = panel.querySelector(`.sh-duty-row[data-idx="${idx - 1}"]`);
          if (prevRow) prevRow.classList.remove('drag-insert-above', 'drag-insert-below');
          const nextRow = panel.querySelector(`.sh-duty-row[data-idx="${idx + 1}"]`);
          if (nextRow) nextRow.classList.remove('drag-insert-above', 'drag-insert-below');
        }
      }
    });

    panel.addEventListener('drop', (e) => {
      e.preventDefault();
      // 清理所有拖拽视觉状态
      if (dragOpacityTimer) { clearTimeout(dragOpacityTimer); dragOpacityTimer = null; }
      panel.querySelectorAll('.sh-duty-row').forEach(r => {
        r.classList.remove('drag-src-fading', 'drag-insert-above', 'drag-insert-below');
        r.style.opacity = '';
      });

      const el = e.target.closest('[data-action="dutyDrag"]'); if (!el || dragSrcIdx === null) return;
      const targetIdx = +el.dataset.idx; if (dragSrcIdx === targetIdx) { dragSrcIdx = null; return; }
      const order = state.dutyOrder || [];
      let ins = dragSrcIdx > targetIdx ? targetIdx : targetIdx + 1;
      if (dragSrcIdx < ins) ins--;
      const [mv] = order.splice(dragSrcIdx, 1); order.splice(ins, 0, mv);
      dragSrcIdx = null; renderPanel(); syncStateToBackground();
    });
  }

  // ==================== 拖拽 ====================
  function makeDraggable(handle, target) {
    let dragging = false, sx, sy, sl, st, moved = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      dragging = true; moved = false;
      sx = e.clientX; sy = e.clientY; const r = target.getBoundingClientRect(); sl = r.left; st = r.top;
      target.style.transition = 'none'; document.body.style.userSelect = 'none';
      const mm = (ev) => {
        if (!dragging) return;
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
        if (moved) { target.style.left = (sl + dx) + 'px'; target.style.top = (st + dy) + 'px'; target.style.right = 'auto'; }
      };
      const mu = () => {
        dragging = false;
        target.style.transition = ''; document.body.style.userSelect = '';
        document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu);
        // 最小化状态下，未拖动 = 单击 → 恢复窗口
        if (!moved && isMinimized) toggleMinimize();
      };
      document.addEventListener('mousemove', mm); document.addEventListener('mouseup', mu);
    });
  }

  // ==================== 面板控制 ====================
  function togglePanel(show) { const p = document.getElementById('scheduling-helper-panel'); if (!p) return; panelVisible = show; if (show) { p.classList.add('visible'); if (isMinimized) toggleMinimize(); goToStep(state.currentStep); document.getElementById('sh-quick-entry').classList.add('hidden'); } else { p.classList.remove('visible'); if (extEnabled) document.getElementById('sh-quick-entry').classList.remove('hidden'); } }
  function toggleMinimize() { const p = document.getElementById('scheduling-helper-panel'), b = document.getElementById('sh-panel-body'), s = document.getElementById('sh-steps-bar'); if (!p) return; isMinimized = !isMinimized; if (isMinimized) { p.classList.add('minimized'); b.style.display = 'none'; s.style.display = 'none'; p.title = '打开浮窗'; document.getElementById('sh-quick-entry').classList.add('hidden'); } else { p.classList.remove('minimized'); b.style.display = ''; s.style.display = ''; p.title = ''; } }

  function goToStep(n) { state.currentStep = n; renderStepsBar(); renderPanel(); }
  function renderStepsBar() {
    document.querySelectorAll('#sh-steps-bar .sh-step-item').forEach(item => {
      const s = +item.dataset.step; item.classList.remove('active', 'done');
      if (s === state.currentStep) item.classList.add('active'); else if (s < state.currentStep) item.classList.add('done');
    });
  }

  // ==================== 面板渲染 ====================
  function renderPanel() { const b = document.getElementById('sh-panel-body'); if (!b) return; switch (state.currentStep) { case 1: renderS1(b); break; case 2: renderS2(b); break; case 3: renderS3(b); break; case 4: renderS4(b); break; case 5: renderS5(b); break; } applyToPageTable(); }

  // ===== S1: 人员 =====
  function renderS1(body) {
    const docs = state.doctors;
    let h = ``;
    // 格式化周一日期
    const monParts = weekInfo.monday.split('-');
    const monLabel = `${parseInt(monParts[1])}月${parseInt(monParts[2])}日周一`;
    // ---- 工作周选择器（通过操作页面Ant Design picker DOM） ----
    h += `<div class="sh-subtitle"><span class="material-icons">calendar_month</span> 工作周切换</div>`;
    h += `<div class="sh-week-picker" style="justify-content:space-between;">`;
    h += `<button class="sh-btn-action sh-btn-outline sh-btn-sm" data-action="goPrevWeek" title="上一周"><span class="material-icons">chevron_left</span> 上一周</button>`;
    h += `<span style="font-weight:600;font-size:13px;white-space:nowrap;"><span style="font-size:10px;font-weight:400;color:#888;">${weekInfo.year}年 </span>第${weekInfo.week}周 <span style="font-size:10px;font-weight:400;color:#888;">· ${monLabel}</span></span>`;
    h += `<button class="sh-btn-action sh-btn-outline sh-btn-sm" data-action="goNextWeek" title="下一周">下一周 <span class="material-icons">chevron_right</span></button>`;
    h += `</div>`;
    h += `<div class="sh-week-picker" style="margin-top:6px;justify-content:space-between;align-items:center;">`;
    // 用 getWeekInfo 从下周一反算，避免年底 52/53 周边界问题
    const currentMonday = new Date(weekInfo.monday);
    const nextMonday = new Date(currentMonday);
    nextMonday.setDate(currentMonday.getDate() + 7);
    const nextWeekInfo = getWeekInfo(nextMonday);
    const nextMonParts = nextWeekInfo.monday.split('-');
    const nextMonLabel = `${parseInt(nextMonParts[1])}月${parseInt(nextMonParts[2])}日周一`;
    h += `<span style="font-size:11px;color:#666;">跳转至 <span style="font-weight:600;color:#333;">第${nextWeekInfo.week}周</span> <span style="font-size:10px;color:#888;">· ${nextMonLabel}</span></span>`;
    h += `<span style="display:flex;align-items:center;gap:4px;">`;
    h += `<input type="number" id="sh-week-num" value="${nextWeekInfo.week}" min="1" max="53" style="width:44px;padding:5px 6px;text-align:center;border:1px solid #d9d9d9;border-radius:4px;font-size:13px;" title="输入周数">`;
    h += `<button class="sh-btn-action sh-btn-primary" data-action="confirmWeek" style="padding:5px 16px;font-size:13px;font-weight:600;">GO</button>`;
    h += `</span>`;
    h += `</div>`;
    // 人员列表
    h += `<div class="sh-divider"></div>`;
    h += `<div class="sh-info-bar info"><span class="material-icons">tips_and_updates</span> 人员数据从系统自动加载。<br>仅显示排班类别为<b>"医疗"</b>和<b>"规培"</b>的人员。</div>`;
    h += `<div class="sh-subtitle"><span class="material-icons">list_alt</span> 人员列表 <span style="font-size:10px;color:#999;font-weight:400;">(${docs.length}人)</span></div>`;
    h += `<ul class="sh-doc-list">`;
    // 预计算导师候选列表（非规培生）
    const mentorCandidates = docs.filter(d => d.type !== 'trainee');
    const mentorOptsHtml = '<option value="">— 未指定 —</option>' +
      mentorCandidates.map(d => `<option value="${d.id}">${d.name} (#${d.number})</option>`).join('');
    for (let d of docs) {
      const tagCls = d.type === 'trainee' ? 'trainee' : d.type === 'director' ? 'director' : 'regular';
      const tagText = d.type === 'trainee' ? '规培' : d.type === 'director' ? '主任' : '医生';
      let rightHtml = '';
      if (d.type === 'trainee') {
        const selectedId = d.mentorId || '';
        rightHtml = `<span style="font-size:11px;color:#555;white-space:nowrap;">导师：<select data-action="updateMentor" data-doc="${d.id}" style="font-size:12px;padding:2px 6px;border:1px solid #bbb;border-radius:4px;max-width:110px;color:#333;" title="指定导师">
          ${mentorOptsHtml.replace(`value="${selectedId}"`, `value="${selectedId}" selected`)}
        </select></span>`;
      }
      let tags = '';
      if (d.training) tags += ' <span class="sh-doc-tag training">培训中</span>';
      if (d.onLeave) tags += ' <span class="sh-doc-tag leave">休假中</span>';
      if (rightHtml) {
        h += `<li style="display:flex;justify-content:space-between;align-items:center;"><span><strong>#${d.number}</strong> ${d.name} <span class="sh-doc-tag ${tagCls}">${tagText}</span>${tags}</span>${rightHtml}</li>`;
      } else {
        h += `<li><span><strong>#${d.number}</strong> ${d.name} <span class="sh-doc-tag ${tagCls}">${tagText}</span>${tags}</span></li>`;
      }
    }
    h += `</ul>`;
    h += `<div class="sh-divider"></div>`;
    h += `<div class="sh-subtitle"><span class="material-icons">calendar_month</span> 工作日 / 节假日设定</div>`;
    h += `<div class="sh-help-text">点击按钮切换：<span style="color:#006A69;">青色=工作日</span>，白色=节假日。</div>`;
    h += `<div class="sh-workday-row">`;
    for (let d = 0; d < 7; d++) { const wd = (state.workdayConfig || [])[d]; h += `<button class="sh-btn-action sh-btn-sm ${wd ? 'sh-btn-primary' : 'sh-btn-outline'}" data-action="toggleWorkday" data-day="${d}">${A.DAYS[d]}</button>`; }
    h += `</div>`;
    h += `<button class="sh-btn-action sh-btn-primary sh-btn-block" data-action="goToStep" data-step="2" style="margin-top:6px;padding:8px 16px;font-size:13px;">下一步 <span class="material-icons">arrow_forward</span> <small>门诊安排</small></button>`;
    body.innerHTML = h;
  }

  // ===== S2: 门诊 =====
  function renderS2(body) {
    let h = `<div class="sh-info-bar info"><span class="material-icons">tips_and_updates</span> 四类门诊分别管理。<br>· 总院门诊 每天上、下午<br>· 简易门诊 时间不固定（表格中显示为总院门诊）<br>· 高新门诊 周内上午<br>· 梓潼门诊 周三上午</div>`;

    // ---- 导入上周门诊区域 ----
    h += renderPrevWeekOutpatientSection();

    // 总院门诊
    h += `<div class="sh-subtitle sh-clinic-title-general"><span class="material-icons">local_hospital</span> 总院门诊</div>`;
    for (let d = 0; d < 7; d++) {
      const gen = state.outpatientGeneral[d] || { am: null, pm: null }; h += `<div style="margin-bottom:4px;font-size:11px;padding:4px 6px;background:#fafafa;border-radius:4px;"><strong>${A.DAYS[d]}</strong><div class="sh-form-row">`;
      for (let s of A.SLOTS) h += `<div style="flex:1;"><span style="font-size:9px;color:#999;">${A.SLOT_LABELS[s]}</span><select data-action="updateGeneral" data-day="${d}" data-slot="${s}" style="font-size:10px;"><option value="">—</option>${docOptsHtmlSelected(gen[s])}</select></div>`; h += `</div></div>`;
    }
    // 高新门诊
    h += `<div class="sh-divider"></div><div class="sh-subtitle sh-clinic-title-gaoxin"><span class="material-icons">local_hospital</span> 高新门诊 <span style="font-size:10px;color:#999;font-weight:400;">（仅上午）</span></div><div id="sh-gaoxin-rows">`;
    (state.outpatientGaoxin || []).forEach((it, i) => { h += renderGxRow(i, it); });
    h += `</div><button class="sh-btn-action sh-btn-outline sh-btn-sm sh-btn-block" data-action="addGaoxin"><span class="material-icons">add</span> 添加高新门诊</button>`;
    // 梓潼门诊
    h += `<div class="sh-divider"></div><div class="sh-subtitle sh-clinic-title-zitong"><span class="material-icons">local_hospital</span> 梓潼门诊 <span style="font-size:10px;color:#999;font-weight:400;">（仅上午 · 每两周周三）</span></div><div id="sh-zitong-rows">`;
    (state.outpatientZitong || []).forEach((it, i) => { h += renderZtRow(i, it); });
    h += `</div><button class="sh-btn-action sh-btn-outline sh-btn-sm sh-btn-block" data-action="addZitong"><span class="material-icons">add</span> 添加梓潼门诊</button>`;
    // 简易门诊
    h += `<div class="sh-divider"></div><div class="sh-subtitle sh-clinic-title-general"><span class="material-icons">local_hospital</span> 简易门诊 <span style="font-size:10px;color:#999;font-weight:400;">（表格中显示为总院门诊）</span></div><div id="sh-simple-rows">`;
    (state.outpatientSimple || []).forEach((it, i) => { h += renderSmRow(i, it); });
    h += `</div><button class="sh-btn-action sh-btn-outline sh-btn-sm sh-btn-block" data-action="addSimple"><span class="material-icons">add</span> 添加简易门诊</button>`;
    // 导出/导入/清空按钮
    h += `<div class="sh-divider"></div><div class="sh-btn-group">`;
    h += `<button class="sh-btn-action sh-btn-outline sh-btn-sm" data-action="exportOutpatient"><span class="material-icons">file_upload</span> 导出配置</button>`;
    h += `<button class="sh-btn-action sh-btn-outline sh-btn-sm" data-action="importOutpatient"><span class="material-icons">file_download</span> 导入配置</button>`;
    h += `<button class="sh-btn-action sh-btn-outline sh-btn-sm" data-action="clearOutpatient"><span class="material-icons">delete</span> 清空门诊</button>`;
    h += `</div>`;
    h += `<div class="sh-nav-row"><button class="sh-btn-action sh-btn-outline" data-action="goToStep" data-step="1"><span class="material-icons">arrow_back</span> 上一步</button><button class="sh-btn-action sh-btn-primary" data-action="goToStep" data-step="3">下一步 <span class="material-icons">arrow_forward</span> <small>特殊安排</small></button></div>`;
    body.innerHTML = h;
  }
  function renderGxRow(i, it) { it = it || {}; return `<div class="sh-form-row" style="align-items:center;margin-bottom:2px;"><select data-action="updateGaoxin" data-idx="${i}" data-field="dayIdx" style="flex:1;font-size:10px;"><option value="">选择日期</option>${[0, 1, 2, 3, 4].map(d => `<option value="${d}" ${it.dayIdx === d ? 'selected' : ''}>${A.DAYS[d]}</option>`).join('')}</select><select data-action="updateGaoxin" data-idx="${i}" data-field="doctorId" style="flex:1;font-size:10px;"><option value="">选择医生</option>${docOptsHtmlSelected(it.doctorId || '')}</select><button class="sh-btn-action sh-btn-danger sh-btn-xs" data-action="removeGaoxin" data-idx="${i}" style="max-width:20px;">✕</button></div>`; }
  function renderZtRow(i, it) { it = it || {}; return `<div class="sh-form-row" style="align-items:center;margin-bottom:2px;"><select data-action="updateZitong" data-idx="${i}" data-field="dayIdx" style="flex:1;font-size:10px;"><option value="">选择日期</option>${[0, 1, 2, 3, 4].map(d => `<option value="${d}" ${it.dayIdx === d ? 'selected' : ''}>${A.DAYS[d]}</option>`).join('')}</select><select data-action="updateZitong" data-idx="${i}" data-field="doctorId" style="flex:1;font-size:10px;"><option value="">选择医生</option>${docOptsHtmlSelected(it.doctorId || '')}</select><button class="sh-btn-action sh-btn-danger sh-btn-xs" data-action="removeZitong" data-idx="${i}" style="max-width:20px;">✕</button></div>`; }
  function renderSmRow(i, it) { it = it || {}; return `<div class="sh-form-row" style="align-items:center;margin-bottom:2px;"><select data-action="updateSimple" data-idx="${i}" data-field="dayIdx" style="flex:1;font-size:10px;"><option value="">日期</option>${[0, 1, 2, 3, 4, 5, 6].map(d => `<option value="${d}" ${it.dayIdx === d ? 'selected' : ''}>${A.DAYS[d]}</option>`).join('')}</select><select data-action="updateSimple" data-idx="${i}" data-field="slot" style="flex:0.7;font-size:10px;"><option value="">时段</option><option value="am" ${it.slot === 'am' ? 'selected' : ''}>上午</option><option value="pm" ${it.slot === 'pm' ? 'selected' : ''}>下午</option></select><select data-action="updateSimple" data-idx="${i}" data-field="doctorId" style="flex:1;font-size:10px;"><option value="">医生</option>${docOptsHtmlSelected(it.doctorId || '')}</select><button class="sh-btn-action sh-btn-danger sh-btn-xs" data-action="removeSimple" data-idx="${i}" style="max-width:20px;">✕</button></div>`; }

  // ===== 上周门诊导入预览渲染 =====
  function renderPrevWeekOutpatientSection() {
    let s = `<div class="sh-divider"></div>`;
    s += `<div class="sh-subtitle" style="color:#006A69;"><span class="material-icons">file_download</span> 从上周导入门诊</div>`;

    if (!prevWeekOutpatientLoaded || !prevWeekOutpatientPreview) {
      const prevMonday = new Date(weekInfo.monday);
      console.log('[排班辅助][门诊导入] weekInfo:', JSON.stringify(weekInfo));
      console.log('[排班辅助][门诊导入] prevMonday(减7前):', prevMonday.toISOString());
      prevMonday.setDate(prevMonday.getDate() - 7);
      console.log('[排班辅助][门诊导入] prevMonday(减7后):', prevMonday.toISOString());
      const prevWeekInfo = getWeekInfo(prevMonday);
      console.log('[排班辅助][门诊导入] getWeekInfo结果:', JSON.stringify(prevWeekInfo));
      const prevLabel = `${prevMonday.getFullYear()}年 第${prevWeekInfo.week}周`;
      s += `<div class="sh-help-text">点击下方按钮，将 <b>${prevLabel}</b> 的门诊安排（总院门诊、高新门诊、梓潼门诊）导入预览。</div>`;
      s += `<button class="sh-btn-action sh-btn-primary sh-btn-block" data-action="fetchPrevWeekOutpatient" style="padding:8px 16px;font-size:13px;"><span class="material-icons">file_download</span> 导入上一周门诊</button>`;
      return s;
    }

    const preview = prevWeekOutpatientPreview;
    const prevLabel = `${new Date(preview.sourceMonday).getFullYear()}年 第${getWeekInfo(new Date(preview.sourceMonday)).week}周`;

    // 状态标签
    s += `<div class="sh-info-bar success" style="margin-bottom:6px;"><span class="material-icons">check_circle</span> 已加载 ${prevLabel} 共 <b>${preview.totalCount}</b> 条门诊记录</div>`;

    // 冲突警告
    if (preview.conflicts.length > 0) {
      s += `<div class="sh-info-bar warn" style="margin-bottom:8px;">`;
      s += `<span class="material-icons">warning</span> 检测到 <b>${preview.conflicts.length}</b> 个时段存在多个总院门诊：`;
      s += `<ul style="margin:4px 0 0 14px;font-size:10px;">`;
      for (let c of preview.conflicts) {
        s += `<li>${c.message}</li>`;
      }
      s += `</ul>`;
      s += `<span class="material-icons">tips_and_updates</span> 应用时自动将第1位设为总院门诊，第2位设为简易门诊。`;
      s += `</div>`;
    }

    // 预览表格
    s += `<div style="max-height:200px;overflow-y:auto;border:1px solid #f0f0f0;border-radius:6px;padding:6px;margin-bottom:8px;">`;
    s += `<table style="width:100%;font-size:10px;border-collapse:collapse;">`;
    s += `<tr style="background:#fafafa;"><th style="padding:3px 4px;text-align:left;min-width:32px;">日期</th><th style="padding:3px 4px;">上午</th><th style="padding:3px 4px;">下午</th></tr>`;
    for (let d = 0; d < 7; d++) {
      const gen = preview.outpatientGeneral[d] || { am: [], pm: [] };
      const gaoxinAM = preview.outpatientGaoxin.filter(a => a.dayIdx === d).map(a => { const doc = getDoctor(a.doctorId); return doc ? doc.name : a.doctorId; });
      const zitongAM = preview.outpatientZitong.filter(a => a.dayIdx === d).map(a => { const doc = getDoctor(a.doctorId); return doc ? doc.name : a.doctorId; });
      const amList = [...gen.am.map(id => { const doc = getDoctor(id); return doc ? doc.name : id; }), ...gaoxinAM.map(n => n + '(高新)'), ...zitongAM.map(n => n + '(梓潼)')];
      const pmList = gen.pm.map(id => { const doc = getDoctor(id); return doc ? doc.name : id; });
      const conflictAM = preview.conflicts.some(c => c.dayIdx === d && c.slot === 'am');
      const conflictPM = preview.conflicts.some(c => c.dayIdx === d && c.slot === 'pm');
      s += `<tr style="border-bottom:1px solid #f0f0f0;${A.isHoliday(state.workdayConfig, d) ? 'background:#fffbe6;' : ''}">`;
      s += `<td style="padding:3px 4px;font-weight:600;">${A.DAYS[d]}</td>`;
      s += `<td style="padding:3px 4px;${conflictAM ? 'background:#fff2f0;color:#cf1322;' : ''}">${amList.join('、') || '<span style="color:#ccc;">—</span>'}</td>`;
      s += `<td style="padding:3px 4px;${conflictPM ? 'background:#fff2f0;color:#cf1322;' : ''}">${pmList.join('、') || '<span style="color:#ccc;">—</span>'}</td>`;
      s += `</tr>`;
    }
    s += `</table></div>`;

    // 操作按钮
    s += `<div class="sh-btn-group">`;
    s += `<button class="sh-btn-action sh-btn-success sh-btn-sm" data-action="applyPrevWeekOutpatient" style="flex:2;"><span class="material-icons">check_circle</span> 应用到本周</button>`;
    s += `<button class="sh-btn-action sh-btn-outline sh-btn-sm" data-action="fetchPrevWeekOutpatient" style="flex:1;"><span class="material-icons">refresh</span> 重新加载</button>`;
    s += `<button class="sh-btn-action sh-btn-outline sh-btn-sm" data-action="clearPrevWeekPreview" style="flex:1;">✕ 清除</button>`;
    s += `</div>`;

    return s;
  }

  // ===== 上周值班顺序导入预览渲染 =====
  function renderPrevWeekDutySection() {
    let s = `<div class="sh-divider"></div>`;
    s += `<div class="sh-subtitle" style="color:#006A69;"><span class="material-icons">file_download</span> 从上周导入值班顺序</div>`;

    if (!prevWeekDutyOrderPreview) {
      const prevMonday = new Date(weekInfo.monday);
      console.log('[排班辅助][值班导入] weekInfo:', JSON.stringify(weekInfo));
      console.log('[排班辅助][值班导入] prevMonday(减7前):', prevMonday.toISOString());
      prevMonday.setDate(prevMonday.getDate() - 7);
      console.log('[排班辅助][值班导入] prevMonday(减7后):', prevMonday.toISOString());
      const prevWeekInfo = getWeekInfo(prevMonday);
      console.log('[排班辅助][值班导入] getWeekInfo结果:', JSON.stringify(prevWeekInfo));
      const prevLabel = `${prevMonday.getFullYear()}年 第${prevWeekInfo.week}周`;
      s += `<div class="sh-help-text">根据 <b>${prevLabel}</b> 的排班数据，自动重建值班医生序列。</div>`;
      s += `<button class="sh-btn-action sh-btn-primary sh-btn-block" data-action="fetchPrevWeekDuty" style="padding:8px 16px;font-size:13px;"><span class="material-icons">file_download</span> 导入上一周值班顺序</button>`;
      return s;
    }

    const preview = prevWeekDutyOrderPreview;

    // 状态标签
    s += `<div class="sh-info-bar success" style="margin-bottom:6px;"><span class="material-icons">check_circle</span> 已重建 <b>${preview.foundCount}/8</b> 位值班顺序`;
    if (preview.missingDays.length > 0) {
      s += ` · <span class="material-icons">warning</span> 缺失：${preview.missingDays.join('、')}`;
    }
    s += `</div>`;

    // 预览表格
    s += `<div style="max-height:220px;overflow-y:auto;border:1px solid #f0f0f0;border-radius:6px;padding:6px;margin-bottom:8px;">`;
    s += `<table style="width:100%;font-size:10px;border-collapse:collapse;">`;
    s += `<tr style="background:#fafafa;"><th style="padding:3px 4px;text-align:center;width:28px;">#</th><th style="padding:3px 4px;">值班日</th><th style="padding:3px 4px;">匹配医生</th></tr>`;
    for (let i = 0; i < 8; i++) {
      const det = preview.details[i] || { dayLabel: '—', doctorName: '—' };
      const doc = det.doctorId ? getDoctor(det.doctorId) : null;
      const hasMatch = !!det.doctorId;
      s += `<tr style="border-bottom:1px solid #f0f0f0;${hasMatch ? '' : 'background:#fffbe6;'}">`;
      s += `<td style="padding:3px 4px;text-align:center;font-weight:600;">${i}</td>`;
      s += `<td style="padding:3px 4px;${hasMatch ? '' : 'color:#faad14;'}">${det.dayLabel}</td>`;
      s += `<td style="padding:3px 4px;${hasMatch ? 'color:#006A69;' : 'color:#ccc;'}">${hasMatch ? (doc ? doc.name : det.doctorId) : '未匹配'}</td>`;
      s += `</tr>`;
    }
    s += `</table></div>`;

    // 操作按钮
    s += `<div class="sh-btn-group">`;
    s += `<button class="sh-btn-action sh-btn-success sh-btn-sm" data-action="applyPrevWeekDutyOrder" style="flex:2;"><span class="material-icons">check_circle</span> 应用此顺序</button>`;
    s += `<button class="sh-btn-action sh-btn-outline sh-btn-sm" data-action="fetchPrevWeekDuty" style="flex:1;"><span class="material-icons">refresh</span> 重新加载</button>`;
    s += `<button class="sh-btn-action sh-btn-outline sh-btn-sm" data-action="clearPrevWeekDutyPreview" style="flex:1;">✕ 清除</button>`;
    s += `</div>`;

    return s;
  }

  // ===== S3: 特殊安排 =====
  function renderS3(body) {
    let h = `<div class="sh-info-bar info"><span class="material-icons">tips_and_updates</span> 为每位医生设置特殊安排。<br>选择医生，勾选时段，再选择类型，可为不同的时间段批量应用班型。<br>特殊安排包括：产假、事假、休、二线、培训、开会、医疗保障、脱产学习。</div>`;
    h += `<label><span class="material-icons">medical_services</span> 选择医生</label><select id="sh-special-doc" data-action="renderSpecialForm"><option value="">— 请选择 —</option>${state.doctors.map(d => `<option value="${d.id}">${d.name} (#${d.number})</option>`).join('')}</select><div id="sh-special-form" style="margin-top:8px;"></div>`;
    h += `<div class="sh-nav-row"><button class="sh-btn-action sh-btn-outline" data-action="goToStep" data-step="2"><span class="material-icons">arrow_back</span> 上一步</button><button class="sh-btn-action sh-btn-primary" data-action="goToStep" data-step="4">下一步 <span class="material-icons">arrow_forward</span> <small>值班排班</small></button></div>`;
    body.innerHTML = h;
  }
  function renderSpecialDocForm() {
    const sel = document.getElementById('sh-special-doc'), fd = document.getElementById('sh-special-form'); if (!sel || !fd) return;
    const did = sel.value; if (!did) { fd.innerHTML = ''; return; }
    const doc = getDoctor(did); if (!state.special) state.special = {}; if (!state.special[did]) state.special[did] = {};
    let h = `<div class="sh-step-section">`;
    h += `<div class="sh-subtitle" style="margin-top:0;"><span class="material-icons">medical_services</span> ${doc.name} <span style="font-size:10px;color:#999;font-weight:400;">#${doc.number}</span></div>`;
    h += `<div class="sh-btn-group"><button class="sh-btn-action sh-btn-xs sh-btn-outline" data-action="toggleAllSpecial" data-on="true" data-doc="${did}">全选</button><button class="sh-btn-action sh-btn-xs sh-btn-outline" data-action="toggleAllSpecial" data-on="false" data-doc="${did}">取消全选</button><button class="sh-btn-action sh-btn-xs sh-btn-outline" data-action="toggleWorkdaySpecial" data-doc="${did}">工作日全选</button><button class="sh-btn-action sh-btn-xs sh-btn-outline" data-action="toggleSlotSpecial" data-doc="${did}" data-slot="am">上午全选</button><button class="sh-btn-action sh-btn-xs sh-btn-outline" data-action="toggleSlotSpecial" data-doc="${did}" data-slot="pm">下午全选</button></div>`;
    h += `<div class="sh-form-row" style="margin:8px 0;"><select id="sh-batch-special-type" style="flex:5;font-size:10px;"><option value="">选择批量应用的类型</option>${A.SPECIAL_TYPES.map(t => `<option value="${t}">${t}</option>`).join('')}</select><button class="sh-btn-action sh-btn-primary sh-btn-sm" data-action="batchSpecial" data-doc="${did}" style="flex:1.5;text-align:center;justify-content:center;">应用</button><button class="sh-btn-action sh-btn-danger sh-btn-sm" data-action="batchClearSpecial" data-doc="${did}" style="flex:1.5;text-align:center;justify-content:center;">清除选中</button></div>`;
    for (let d = 0; d < 7; d++) {
      const sp = (state.special[did] || {})[d] || { am: null, pm: null }; const bg = A.isHoliday(state.workdayConfig, d) ? '#fffbe6' : '#fafafa'; h += `<div style="margin-bottom:3px;padding:5px 8px;background:${bg};border-radius:4px;font-size:10px;display:flex;align-items:center;gap:4px;"><strong style="min-width:30px;">${A.DAYS[d]}</strong>`;
      for (let sl of A.SLOTS) h += `<label style="display:flex;align-items:center;gap:2px;flex:1;font-size:9px;cursor:pointer;"><input type="checkbox" class="sh-special-chk" data-doc="${did}" data-day="${d}" data-slot="${sl}">${A.SLOT_LABELS[sl]}<select data-action="updateSpecial" data-doc="${did}" data-day="${d}" data-slot="${sl}" style="flex:1;font-size:10px;"><option value="">—</option>${A.SPECIAL_TYPES.map(t => `<option value="${t}" ${sp[sl] === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`;
      h += `<span style="font-size:8px;color:#999;min-width:44px;text-align:right;">${sp.am || '—'} / ${sp.pm || '—'}</span></div>`;
    }
    h += `</div>`;
    fd.innerHTML = h;
  }

  // ===== S4: 值班 =====
  function renderS4(body) {
    if (!state.dutyOrder || state.dutyOrder.length !== 8) state.dutyOrder = A.buildDefaultDutyOrder(state.doctors);
    const order = state.dutyOrder || [], pool = A.getDutyDoctorPool(state.doctors), flags = state.baiban1Flags || [];
    let h = `<div class="sh-info-bar info"><span class="material-icons">tips_and_updates</span>· 按住 ⋮⋮ 拖拽调整顺序。<br>· 节假日的中班自动转为休假。<br>· 已有安排不会被覆盖，安排后与门诊等冲突时，相应格子会闪烁提示。<br>· 重新执行自动排班，请先点清空按钮。</div>`;

    // ---- 导入上周值班顺序区域 ----
    h += renderPrevWeekDutySection();

    h += `<div class="sh-subtitle"><span class="material-icons">list_alt</span> 值班序列 <span style="font-size:10px;color:#999;font-weight:400;">(${order.filter(id => id && getDoctor(id)).length}/8)</span></div>`;
    h += `<div id="sh-duty-order">`;
    for (let i = 0; i < 8; i++) { const did = order[i] || '', doc = getDoctor(did); h += `<div class="sh-duty-row" draggable="true" data-action="dutyDrag" data-idx="${i}"><span class="sh-drag-handle">⋮⋮</span><select data-action="updateDutyOrder" data-idx="${i}" style="flex:1;max-width:110px;font-size:10px;"><option value="">— 空 —</option>${pool.map(d => `<option value="${d.id}" ${did === d.id ? 'selected' : ''}>${d.name}</option>`).join('')}</select><span class="sh-duty-desc">${A.getDutyRowDesc(state.workdayConfig, i)}</span></div>`; }
    h += `</div>`;
    h += `<div class="sh-btn-group" style="margin-top:8px;"><button class="sh-btn-action sh-btn-outline sh-btn-sm" data-action="resetDutyOrder"><span class="material-icons">refresh</span> 重置默认顺序</button><label style="font-size:10px;display:flex;align-items:center;gap:4px;margin-left:auto;cursor:pointer;"><input type="checkbox" id="sh-cancel-zb"> 假期前一天取消中班</label></div>`;
    h += `<button class="sh-btn-action sh-btn-primary sh-btn-block" data-action="runAutoDuty" style="margin-top:6px;padding:8px 16px;font-size:13px;"><span class="material-icons">manage_history</span> 执行自动排班</button>`;
    h += `<button class="sh-btn-action sh-btn-danger sh-btn-block" data-action="clearDuty" style="margin-top:4px; font-size: 13px;"><span class="material-icons">delete</span> 清空值班安排</button>`;
    if (flags.length) h += `<div class="sh-info-bar warn" style="margin-top:8px;"><span class="material-icons">warning</span> 检测到 <b>${flags.length}</b> 个安排冲突，请前往下一步处理。</div>`;
    else h += `<div class="sh-info-bar success" style="margin-top:8px;"><span class="material-icons">check_circle</span> 暂无冲突</div>`;
    h += `<div class="sh-nav-row"><button class="sh-btn-action sh-btn-outline" data-action="goToStep" data-step="3"><span class="material-icons">arrow_back</span> 上一步</button><button class="sh-btn-action sh-btn-primary" data-action="goToStep" data-step="5">下一步 <span class="material-icons">arrow_forward</span> <small>调整确认</small></button></div>`;
    body.innerHTML = h;
    const cb = document.getElementById('sh-cancel-zb'); if (cb) { cb.checked = state.cancelPreHolidayZhongban; cb.addEventListener('change', function () { state.cancelPreHolidayZhongban = this.checked; }); }
  }

  // ===== S5: 确认 =====
  function renderS5(body) {
    const flags = state.baiban1Flags || [], trainees = state.doctors.filter(d => d.type === 'trainee');
    let h = `<div class="sh-info-bar info"><span class="material-icons">tips_and_updates</span> 点击下方"分配白1"按钮，可快速安排白班1！</div>`;

    // ===== （一）调整冲突 =====
    h += `<div class="sh-subtitle" style="font-size:13px;color:#333;">（一）调整冲突</div>`;
    if (flags.length) {
      h += `<div class="sh-info-bar warn" style="margin-bottom:0;"><span class="material-icons">warning</span> ${flags.length}个冲突可能需要安排白班1</div><ul class="sh-conflict-list">`;
      for (let f of flags) {
        const resolved = !!f.resolvedBy;
        h += `<li class="${resolved ? 'resolved' : ''}" style="${resolved ? 'background:#f5f5f5;border-color:#d9d9d9;text-decoration:none;opacity:1;' : ''}"><span class="material-icons">${resolved ? 'info' : 'warning'}</span><span style="flex:1;font-size:10px;">${f.reason}</span><span style="font-size:9px;color:#999;">${A.DAYS[f.dayIdx]}${A.SLOT_LABELS[f.slot]}</span>${resolved ? '' : `<button class="sh-btn-action sh-btn-primary sh-btn-xs" data-action="quickBaiban1" data-day="${f.dayIdx}" data-slot="${f.slot}">分配白1</button>`}</li>`;
      }
      h += `</ul>`;
    } else {
      h += `<div class="sh-info-bar success"><span class="material-icons">check_circle</span> 所有冲突已解决！</div>`;
    }

    // ===== （二）安排周末门诊 =====
    h += `<div class="sh-divider"></div><div class="sh-subtitle" style="font-size:13px;color:#333;">（二）安排周末门诊</div>`;
    // 列出所有节假日及其索引
    var holidayDayNames = [];
    var holidayDayIndices = [];
    for (let d = 0; d < 7; d++) {
      if (A.isHoliday(state.workdayConfig, d)) {
        holidayDayNames.push(A.DAYS[d]);
        holidayDayIndices.push(d);
      }
    }
    if (holidayDayNames.length > 0) {
      // 检测已安排门诊的节假日
      var arrangedDays = [];
      var unarrangedDays = [];
      for (var hi = 0; hi < holidayDayNames.length; hi++) {
        var hd = holidayDayIndices[hi];
        var gen = state.outpatientGeneral[hd] || { am: null, pm: null };
        var hasGx = (state.outpatientGaoxin || []).some(function (a) { return a.dayIdx === hd; });
        var hasZt = (state.outpatientZitong || []).some(function (a) { return a.dayIdx === hd; });
        var amArranged = gen.am || hasGx || hasZt;
        var pmArranged = gen.pm;
        if (amArranged && pmArranged) {
          arrangedDays.push(holidayDayNames[hi]);
        } else {
          unarrangedDays.push(holidayDayNames[hi]);
        }
      }
      if (unarrangedDays.length > 0) {
        h += `<div class="sh-info-bar warn" style="font-size:10px;"><span class="material-icons">edit_calendar</span> 请手动安排 <b>${unarrangedDays.join('、')}</b> 的周末门诊。</div>`;
      } else {
        h += `<div class="sh-info-bar success" style="font-size:10px;"><span class="material-icons">check_circle</span> ${holidayDayNames.join('、')} 周末门诊已全部安排完毕。</div>`;
      }
    } else {
      h += `<div class="sh-help-text">本周无节假日，无需安排周末门诊。</div>`;
    }

    // ===== （三）周末值班补休 =====
    h += `<div class="sh-divider"></div><div class="sh-subtitle" style="font-size:13px;color:#333;">（三）周末值班补休</div>`;
    const wkDutyDocs = A.getWeekendDutyDoctors(state);
    if (wkDutyDocs.length > 0) {
      const names = wkDutyDocs.map(d => d.name).join('、');
      h += `<div class="sh-info-bar info" style="font-size:10px;">${names} 节假日参与值班，请在本周工作日为其分别找一个人员充足的下午安排休假。</div>`;
    } else {
      h += `<div class="sh-help-text">本周无人在节假日值班，无需安排补休。</div>`;
    }

    // ===== （四）一键填补空缺 =====
    h += `<div class="sh-divider"></div><div class="sh-subtitle" style="font-size:13px;color:#333;">（四）一键填补空缺</div>`;
    h += `<div class="sh-help-text">依据设定的工作日/节假日：<br>工作日→<b style="color:#2196f3;">白班普</b> · 节假日→<b style="color:#999;">休假</b></div>`;
    h += `<button class="sh-btn-action sh-btn-primary sh-btn-block" data-action="fillEmpty" style="margin-bottom:8px;padding:8px 16px;font-size:13px;"><span class="material-icons">water_drop</span> 一键填空（白班普/休）</button>`;

    // ===== （五）规培生一键安排 =====
    if (trainees.length) {
      h += `<div class="sh-divider"></div><div class="sh-subtitle" style="font-size:13px;color:#333;">（五）规培生一键安排</div>`;
      h += `<div class="sh-help-text">为 ${trainees.map(d => d.name).join('、')} 应用对应导师的排班（已设定的安排不会被覆盖）。</div>`;
      h += `<button class="sh-btn-action sh-btn-success sh-btn-block" data-action="syncTrainees"><span class="material-icons">sync</span> 为规培生应用导师排班</button>`;
    }

    // ===== 流程结束 =====
    h += `<div class="sh-divider"></div><div class="sh-subtitle" style="font-size:16px;color:#333;"><span class="material-icons" style="color: rgb(56, 158, 13);">check_circle</span> 排班流程结束！</div>`;

    // 统计
    const stats = A.computeWeekStats(state);
    h += `<div class="sh-divider"></div><div class="sh-subtitle"><span class="material-icons">bar_chart</span> 本周统计</div>`;
    h += `<div class="sh-stats-wrap">${Object.entries(stats).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span class="sh-stat-tag" style="background:${A.TYPE_COLORS[k]}18;border-color:${A.TYPE_COLORS[k]}44;color:${A.TYPE_COLORS[k]};">${k}: ${v}次</span>`).join('') || '<span style="font-size:10px;color:#999;">暂无数据</span>'}</div>`;

    // 导出 / 导入 / 提交
    h += `<div class="sh-btn-group" style="margin-top:10px;">`;
    h += `<button class="sh-btn-action sh-btn-primary sh-btn-sm" data-action="exportFull"><span class="material-icons">file_upload</span> 导出完整配置</button>`;
    h += `<button class="sh-btn-action sh-btn-outline sh-btn-sm" data-action="importFull"><span class="material-icons">file_download</span> 导入完整配置</button>`;
    h += `</div>`;
    h += `<button class="sh-btn-action sh-btn-primary sh-btn-block" data-action="submitAll" style="margin-top:10px;padding:9px 16px;font-size:13px;"><span class="material-icons">check_circle</span> 提交所有修改到系统</button>`;
    h += `<div class="sh-nav-row"><button class="sh-btn-action sh-btn-outline" data-action="goToStep" data-step="4"><span class="material-icons">arrow_back</span> 上一步</button></div>`;
    body.innerHTML = h;
  }

  // ==================== 工作周切换 ====================

  /**
   * 确保页面处于"周"视图模式（DOM fallback 需要）
   */
  function ensureWeekMode() {
    // 先检查是否已在周模式
    var weekInput = document.querySelector('.ant-radio-button-wrapper input[value="week"]');
    if (weekInput && weekInput.checked) return true;

    // 通过 React fiber 直接触发 RadioGroup 的 onChange
    var radioGroup = document.querySelector('.ant-radio-group-outline');
    if (radioGroup) {
      var fk = Object.keys(radioGroup).find(function (k) {
        return k.startsWith('__reactInternalInstance') || k.startsWith('__reactFiber');
      });
      if (fk) {
        var fiber = radioGroup[fk];
        for (var i = 0; i < 10 && fiber; i++) {
          var props = fiber.memoizedProps || {};
          if (typeof props.onChange === 'function') {
            props.onChange({ target: { value: 'week' } });
            return true;
          }
          fiber = fiber.return;
        }
      }
    }

    // fallback: DOM 方式
    var radios = document.querySelectorAll('.ant-radio-button-wrapper');
    for (var j = 0; j < radios.length; j++) {
      var r = radios[j];
      if (r.textContent.trim() === '周') {
        r.click();
        return true;
      }
    }
    return false;
  }

  /**
   * 等待picker下拉出现（DOM fallback 需要）
   */
  function waitForPickerDropdown(timeoutMs) {
    timeoutMs = timeoutMs || 3000;
    return new Promise(function (resolve, reject) {
      var start = Date.now();
      function check() {
        var rows = document.querySelectorAll('.ant-picker-week-panel-row');
        if (rows.length > 0) { resolve(rows); return; }
        if (Date.now() - start > timeoutMs) { reject(new Error('picker下拉未出现')); return; }
        setTimeout(check, 80);
      }
      check();
    });
  }

  /**
   * 从当前可见的picker下拉中读取所有周信息（DOM fallback 需要）
   */
  function readVisibleWeeks() {
    var rows = document.querySelectorAll('.ant-picker-week-panel-row');
    var result = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var weekCell = row.querySelector('.ant-picker-cell-week');
      var dayCells = row.querySelectorAll('td:not(.ant-picker-cell-week)');
      var firstDay = dayCells[0];
      var weekNum = parseInt((weekCell && weekCell.textContent || '').trim(), 10);
      var monday = (firstDay && firstDay.getAttribute('title')) || '';
      if (!isNaN(weekNum)) result.push({ week: weekNum, monday: monday, row: row });
    }
    return result;
  }

  /**
   * 在picker下拉中点击目标周（DOM fallback）
   */
  async function clickWeekInPicker(targetWeek) {
    var weeks = readVisibleWeeks();
    var found = weeks.find(function (w) { return w.week === targetWeek; });
    if (found) {
      found.row.click();
      await new Promise(function (r) { setTimeout(r, 200); });
      return { week: found.week, monday: found.monday };
    }
    var minWeek = Math.min.apply(null, weeks.map(function (w) { return w.week; }));
    var maxWeek = Math.max.apply(null, weeks.map(function (w) { return w.week; }));
    if (targetWeek < minWeek) {
      var prevBtn = document.querySelector('.ant-picker-header-prev-btn');
      if (prevBtn) { prevBtn.click(); await new Promise(function (r) { setTimeout(r, 300); }); return clickWeekInPicker(targetWeek); }
    } else if (targetWeek > maxWeek) {
      var nextBtn = document.querySelector('.ant-picker-header-next-btn');
      if (nextBtn) { nextBtn.click(); await new Promise(function (r) { setTimeout(r, 300); }); return clickWeekInPicker(targetWeek); }
    }
    throw new Error('无法找到第' + targetWeek + '周');
  }

  /**
   * 核心：切换到目标工作周
   * 优先通过 bridge 调用 React fiber onChange（极快），失败则回退到DOM操作
   * @param {number} targetWeek - 目标ISO周数
   * @returns {Promise<{year: number, week: number, monday: string}>}
   */
  async function navigatePickerToWeek(targetWeek) {
    // 【快速路径】通过 bridge 在主世界调用 React fiber onChange
    try {
      var fiberResult = await ScheduleAPI.switchWeek(targetWeek);
      if (fiberResult && fiberResult.year && fiberResult.monday) {
        // 用 getWeekInfo 统一重算：picker/API 返回的 "monday" 可能是周日（antd 默认周日为首日）
        var norm = getWeekInfo(new Date(fiberResult.monday));
        console.log('[排班辅助] ⚡ fiber切换成功:', norm.year, '年 第', norm.week, '周 (原始week:', fiberResult.week, ', 原始monday:', fiberResult.monday, ')');
        return { year: norm.year, week: norm.week, monday: norm.monday };
      }
    } catch (e) {
      console.warn('[排班辅助] fiber切换失败，回退DOM:', e.message);
    }

    // 【慢速回退】DOM 操作 Ant Design picker
    console.log('[排班辅助] 使用DOM回退方式切换周...');
    ensureWeekMode();

    var existingDropdown = document.querySelector('.ant-picker-dropdown');
    if (existingDropdown) { document.body.click(); await new Promise(function (r) { setTimeout(r, 200); }); }

    var pickerInput = document.querySelector('.ant-picker input');
    if (!pickerInput) throw new Error('找不到周选择器');
    pickerInput.click();
    await waitForPickerDropdown();

    var result = await clickWeekInPicker(targetWeek);
    // 用 getWeekInfo 统一重算：picker 第1列是周日（antd 默认），不是周一
    var norm = getWeekInfo(new Date(result.monday));
    console.log('[排班辅助] DOM切换:', norm.year, '年 第', norm.week, '周 (picker显示', result.week, '周, 首列日期:', result.monday, ') → 修正周一:', norm.monday);
    return { year: norm.year, week: norm.week, monday: norm.monday };
  }

  /**
   * 切换到上一周
   */
  async function goToPrevWeek() {
    try {
      const currentFromPicker = readCurrentWeekFromPicker();
      const currentWeek = currentFromPicker || weekInfo.week;
      const targetWeek = Math.max(1, currentWeek - 1);
      const result = await navigatePickerToWeek(targetWeek);
      await onWeekChanged(result);
    } catch (err) {
      console.error('[排班辅助] 切换上一周失败:', err.message);
      showToast('切换失败: ' + err.message, 'error');
    }
  }

  /**
   * 切换到下一周
   */
  async function goToNextWeek() {
    try {
      const currentFromPicker = readCurrentWeekFromPicker();
      const currentWeek = currentFromPicker || weekInfo.week;
      const result = await navigatePickerToWeek(currentWeek + 1);
      await onWeekChanged(result);
    } catch (err) {
      console.error('[排班辅助] 切换下一周失败:', err.message);
      showToast('切换失败: ' + err.message, 'error');
    }
  }

  /**
   * 从页面picker的input中读取当前周数
   */
  function readCurrentWeekFromPicker() {
    try {
      const pickerInput = document.querySelector('.ant-picker input');
      if (!pickerInput) return null;
      const val = pickerInput.value || pickerInput.getAttribute('value') || '';
      // 格式: "2026-29周"
      const match = val.match(/(\d{4})-(\d{1,2})周/);
      if (match) {
        return parseInt(match[2], 10);
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /**
   * 切换到指定周（用户输入周数）
   */
  async function confirmWeekChange() {
    const weekEl = document.getElementById('sh-week-num');
    if (!weekEl) return;
    const targetWeek = parseInt(weekEl.value, 10);
    if (isNaN(targetWeek) || targetWeek < 1 || targetWeek > 53) {
      showToast('请输入有效的周数(1-53)', 'warn'); return;
    }
    try {
      const result = await navigatePickerToWeek(targetWeek);
      await onWeekChanged(result);
    } catch (err) {
      console.error('[排班辅助] 切换指定周失败:', err.message);
      showToast('切换失败: ' + err.message, 'error');
    }
  }

  /**
   * 周切换完成后，更新weekInfo并重新加载数据
   */
  async function onWeekChanged(result) {
    weekInfo = { year: result.year, week: result.week, monday: result.monday };

    // 清除门诊和值班预览缓存
    prevWeekOutpatientPreview = null;
    prevWeekOutpatientLoaded = false;
    prevWeekDutyOrderPreview = null;

    // 重新加载所有数据（页面已通过API加载了对应周的数据）
    try {
      await refreshAllData();
      console.log('[排班辅助] 工作周切换完成，医生' + state.doctors.length + '人');
      syncStateToBackground();
      chrome.runtime.sendMessage({ type: 'UPDATE_WEEK_INFO', weekInfo });
      renderPanel();
      showToast(`已切换到 ${result.year}年 第${result.week}周`, 'success');
    } catch (err) {
      console.error('[排班辅助] 数据刷新失败:', err.message);
      showToast('数据刷新失败: ' + err.message, 'error');
    }
  }

  // ==================== 上周门诊导入 ====================
  /**
   * 拉取上周门诊数据并预览（不直接应用）
   */
  async function fetchAndPreviewPrevWeekOutpatient() {
    if (!state.doctors.length) { showToast('请先确保人员数据已加载', 'warn'); return; }

    const pm = new Date(weekInfo.monday);
    pm.setDate(pm.getDate() - 7);
    const pms = fmtLocalDate(pm);
    const pme = getSunday(pms);

    showToast('正在加载上周门诊数据...', 'info');
    console.log('[排班辅助] 拉取上周(', pms, '~', pme, ')门诊数据... classIdMap有', Object.keys(classIdMap).length, '个映射');

    try {
      const eids = state.doctors.map(d => d.id);
      const sr = await ScheduleAPI.fetchEmpSchedules({ empIds: eids, from: pms, to: pme });
      if (sr.error || !sr.data) {
        showToast('获取上周排班失败: ' + (sr.message || '无数据'), 'error'); return;
      }

      const scheds = Array.isArray(sr.data) ? sr.data : (sr.data.employees || sr.data.data || sr.data.rows || sr.data.list || []);
      const m = new Date(pms);
      const d2i = {};
      for (let d = 0; d < 7; d++) {
        const dt = new Date(m); dt.setDate(m.getDate() + d);
        d2i[fmtLocalDate(dt)] = d;
      }

      // 初始化预览结构
      const previewGeneral = {}; // {dayIdx: {am: [doctorIds], pm: [doctorIds]}}
      const previewGaoxin = [];
      const previewZitong = [];
      const conflicts = []; // {dayIdx, slot, doctorIds:[]}
      for (let d = 0; d < 7; d++) previewGeneral[d] = { am: [], pm: [] };

      let totalParsed = 0;
      var skippedPrevNoEid = 0, skippedPrevNoCn = 0, skippedPrevNoDate = 0, skippedPrevNoDoc = 0, skippedPrevNonOutpatient = 0;
      var prevCnSamples = {}; // 统计所有解析到的班型名称

      for (let r of scheds) {
        const eid = String(r.empId || r.employeeId || '');
        const wd = (r.workDate || r.date || '').slice(0, 10);
        // 优先用 classId / scheduleClassId 查 classIdMap，回退到 name/className 直接匹配
        // 注意：r.id 是排班记录ID，不是班型ID，不能用于 classIdMap 查找
        var cn = classIdMap[String(r.classId || r.scheduleClassId || '')]
          || r.name || r.className || '';
        // 兜底：如果 cn 不在已知班型列表中，尝试直接用 r.name / r.className
        if (cn && !A.SCHEDULE_TYPES.includes(cn) && !A.CLINIC_TYPES.includes(cn) && !A.SPECIAL_TYPES.includes(cn) && !A.DUTY_TYPES.includes(cn)) {
          cn = r.name || r.className || cn;
        }
        const di = d2i[wd];
        if (!eid) { skippedPrevNoEid++; continue; }
        if (!cn) { skippedPrevNoCn++; continue; }
        if (di === undefined) { skippedPrevNoDate++; continue; }

        // 仅检查当前周存在的医生
        const docExists = state.doctors.some(d => d.id === eid);
        if (!docExists) { skippedPrevNoDoc++; continue; }

        // 统计班型
        prevCnSamples[cn] = (prevCnSamples[cn] || 0) + 1;

        const sl = r.segment ? (r.segment === 1 ? 'am' : 'pm') : (r.slot || r.ampm || r.timeSlot || 'am');
        const applySlots = (r.amount >= 1) ? ['am', 'pm'] : [sl];

        for (var si3 = 0; si3 < applySlots.length; si3++) {
          var curSlot3 = applySlots[si3];
          if (cn === '总院门诊') {
            if (!previewGeneral[di]) previewGeneral[di] = { am: [], pm: [] };
            if (!previewGeneral[di][curSlot3].includes(eid)) {
              previewGeneral[di][curSlot3].push(eid);
            }
            totalParsed++;
          } else if (cn === '高新门诊') {
            if (!previewGaoxin.find(a => a.dayIdx === di && a.doctorId === eid)) {
              previewGaoxin.push({ dayIdx: di, doctorId: eid });
              totalParsed++;
            }
          } else if (cn === '梓潼门诊') {
            if (!previewZitong.find(a => a.dayIdx === di && a.doctorId === eid)) {
              previewZitong.push({ dayIdx: di, doctorId: eid });
              totalParsed++;
            }
          }
        }
      }

      // 检测冲突：同一时段有两个及以上总院门诊
      for (let d = 0; d < 7; d++) {
        for (let sl of ['am', 'pm']) {
          const arr = (previewGeneral[d] && previewGeneral[d][sl]) ? previewGeneral[d][sl] : [];
          if (arr.length >= 2) {
            const names = arr.map(id => { const doc = getDoctor(id); return doc ? doc.name : id; });
            conflicts.push({
              dayIdx: d, slot: sl,
              doctorIds: arr,
              message: `${A.DAYS[d]}${A.SLOT_LABELS[sl]} 存在 ${arr.length} 个总院门诊 (${names.join('、')})，请手动区分总院门诊和简易门诊`
            });
          }
        }
      }

      prevWeekOutpatientPreview = {
        sourceMonday: pms,
        outpatientGeneral: previewGeneral,
        outpatientGaoxin: previewGaoxin,
        outpatientZitong: previewZitong,
        conflicts: conflicts,
        totalCount: totalParsed
      };
      prevWeekOutpatientLoaded = true;

      console.log('[排班辅助] 📥 上周门诊解析完成: 总记录=' + scheds.length +
        ' 过滤(缺员工=' + skippedPrevNoEid + ' 缺班型=' + skippedPrevNoCn +
        ' 缺日期=' + skippedPrevNoDate + ' 无此医生=' + skippedPrevNoDoc + ') 门诊=' + totalParsed + '条');
      console.log('[排班辅助] 📊 上周班型分布:', JSON.stringify(prevCnSamples));
      console.log('[排班辅助] 📊 门诊明细: 总院',
        Object.values(previewGeneral).reduce((s, d) => s + (d.am || []).length + (d.pm || []).length, 0),
        '条, 高新', previewGaoxin.length, '条, 梓潼', previewZitong.length, '条, 冲突', conflicts.length, '个');

      if (totalParsed === 0) {
        showToast('上周无门诊数据可导入', 'warn');
      } else {
        const msg = `已加载上周 ${totalParsed} 条门诊记录` + (conflicts.length ? `，⚠️ ${conflicts.length} 个时段存在多个总院门诊需手动处理` : '');
        showToast(msg, conflicts.length ? 'warn' : 'success');
      }
      renderPanel();
    } catch (err) {
      console.error('[排班辅助] 拉取上周门诊失败:', err.message);
      showToast('拉取失败: ' + err.message, 'error');
    }
  }

  /**
   * 将预览的上周门诊数据应用到当前排班状态
   * 冲突时段跳过（需用户手动处理），其余直接写入 state
   */
  function applyPrevWeekOutpatient() {
    if (!prevWeekOutpatientPreview) { showToast('请先导入上周门诊数据', 'warn'); return; }
    const preview = prevWeekOutpatientPreview;
    let appliedGeneral = 0, appliedGaoxin = 0, appliedZitong = 0, skippedConflict = 0, skippedOccupied = 0, skippedEmpty = 0;

    console.log('[排班辅助] 📋 开始应用上周门诊预览...');
    console.log('[排班辅助]   预览数据: 总院门诊',
      Object.values(preview.outpatientGeneral).reduce((s, d) => s + (d.am || []).length + (d.pm || []).length, 0),
      '条, 高新门诊', preview.outpatientGaoxin.length, '条, 梓潼门诊', preview.outpatientZitong.length, '条');

    // 找出冲突的时段集合
    const conflictSet = new Set();
    for (let c of preview.conflicts) {
      conflictSet.add(`${c.dayIdx}_${c.slot}`);
    }

    // 统计本周节假日天数
    var holidayDayIndices = [];
    for (let d = 0; d < 7; d++) {
      if (A.isHoliday(state.workdayConfig, d)) holidayDayIndices.push(d);
    }
    var skippedHoliday = 0;

    // 应用总院门诊（跳过冲突时段 + 跳过节假日）
    for (let d = 0; d < 7; d++) {
      // 跳过本周节假日
      if (A.isHoliday(state.workdayConfig, d)) {
        for (let sl of ['am', 'pm']) {
          const arr = (preview.outpatientGeneral[d] && preview.outpatientGeneral[d][sl]) ? preview.outpatientGeneral[d][sl] : [];
          if (arr.length > 0) skippedHoliday++;
        }
        continue;
      }
      for (let sl of ['am', 'pm']) {
        const key = `${d}_${sl}`;
        if (conflictSet.has(key)) {
          skippedConflict++;
          continue;
        }
        const arr = (preview.outpatientGeneral[d] && preview.outpatientGeneral[d][sl]) ? preview.outpatientGeneral[d][sl] : [];
        if (arr.length === 0) { skippedEmpty++; continue; }
        // 取第一个作为总院门诊，第 2 个及以后 → 简易门诊
        const eid = arr[0];
        if (!state.outpatientGeneral[d]) state.outpatientGeneral[d] = { am: null, pm: null };
        if (!state.outpatientGeneral[d][sl]) {
          state.outpatientGeneral[d][sl] = eid;
          appliedGeneral++;
          console.log('[排班辅助]   ✅ 应用总院门诊:', A.DAYS[d], A.SLOT_LABELS[sl], '→', (getDoctor(eid) || {}).name || eid);
        } else {
          skippedOccupied++;
          console.log('[排班辅助]   ⏭️ 跳过(已占用):', A.DAYS[d], A.SLOT_LABELS[sl], '已有:', (getDoctor(state.outpatientGeneral[d][sl]) || {}).name || state.outpatientGeneral[d][sl]);
        }
        // 第 2 个及以后 → 简易门诊
        for (var ai = 1; ai < arr.length; ai++) {
          var eidN = arr[ai];
          if (!(state.outpatientSimple || []).some(function (a) { return a.dayIdx === d && a.slot === sl && a.doctorId === eidN; })) {
            if (!state.outpatientSimple) state.outpatientSimple = [];
            state.outpatientSimple.push({ dayIdx: d, slot: sl, doctorId: eidN });
            console.log('[排班辅助]   📝 第' + (ai + 1) + '位→简易门诊:', (getDoctor(eidN) || {}).name || eidN);
          }
        }
      }
    }

    // 应用高新门诊（跳过节假日）
    for (let ga of preview.outpatientGaoxin) {
      if (A.isHoliday(state.workdayConfig, ga.dayIdx)) { skippedHoliday++; continue; }
      const exists = (state.outpatientGaoxin || []).some(
        a => a.dayIdx === ga.dayIdx && a.doctorId === ga.doctorId
      );
      if (!exists) {
        if (!state.outpatientGaoxin) state.outpatientGaoxin = [];
        state.outpatientGaoxin.push({ dayIdx: ga.dayIdx, doctorId: ga.doctorId });
        appliedGaoxin++;
        console.log('[排班辅助]   ✅ 应用高新门诊:', A.DAYS[ga.dayIdx], '→', (getDoctor(ga.doctorId) || {}).name || ga.doctorId);
      } else {
        console.log('[排班辅助]   ⏭️ 跳过高新(已存在):', A.DAYS[ga.dayIdx], (getDoctor(ga.doctorId) || {}).name || ga.doctorId);
      }
    }

    // 应用梓潼门诊（跳过节假日）
    for (let zt of preview.outpatientZitong) {
      if (A.isHoliday(state.workdayConfig, zt.dayIdx)) { skippedHoliday++; continue; }
      const exists = (state.outpatientZitong || []).some(
        a => a.dayIdx === zt.dayIdx && a.doctorId === zt.doctorId
      );
      if (!exists) {
        if (!state.outpatientZitong) state.outpatientZitong = [];
        state.outpatientZitong.push({ dayIdx: zt.dayIdx, doctorId: zt.doctorId });
        appliedZitong++;
        console.log('[排班辅助]   ✅ 应用梓潼门诊:', A.DAYS[zt.dayIdx], '→', (getDoctor(zt.doctorId) || {}).name || zt.doctorId);
      } else {
        console.log('[排班辅助]   ⏭️ 跳过梓潼(已存在):', A.DAYS[zt.dayIdx], (getDoctor(zt.doctorId) || {}).name || zt.doctorId);
      }
    }

    // 清除节假日门诊（确保节假日门诊格为空）
    for (var hi = 0; hi < holidayDayIndices.length; hi++) {
      var hd = holidayDayIndices[hi];
      if (state.outpatientGeneral[hd]) {
        state.outpatientGeneral[hd] = { am: null, pm: null };
      }
    }

    syncStateToBackground();
    renderPanel();

    console.log('[排班辅助] 📊 应用结果: 总院×' + appliedGeneral + ' 高新×' + appliedGaoxin + ' 梓潼×' + appliedZitong +
      ' | 跳过: 冲突×' + skippedConflict + ' 已占用×' + skippedOccupied + ' 空×' + skippedEmpty + ' 节假日×' + skippedHoliday);

    let msg = `已应用：总院门诊×${appliedGeneral} 高新门诊×${appliedGaoxin} 梓潼门诊×${appliedZitong}`;
    if (skippedConflict > 0) msg += `\n⚠️ ${skippedConflict} 个冲突时段已跳过，请手动处理`;
    if (skippedOccupied > 0) msg += `\n⏭️ ${skippedOccupied} 个时段已有安排，未覆盖`;
    if (preview.conflicts.length > 0) {
      msg += '\n💡 多个总院门诊的时段已自动将第2位设为简易门诊，请检查确认。';
    }
    if (skippedHoliday > 0) {
      var holidayNames = holidayDayIndices.map(function (d) { return A.DAYS[d]; }).join('、');
      msg += '\n📅 本周' + holidayNames + '为节假日，上周门诊数据已跳过，请在值班安排完成后手动指定周末门诊。';
    }
    if (appliedGeneral === 0 && appliedGaoxin === 0 && appliedZitong === 0) {
      msg += '\n⚠️ 未应用任何门诊数据，请检查控制台日志排查原因。';
    }
    showToast(msg, (appliedGeneral + appliedGaoxin + appliedZitong) === 0 ? 'warn' :
      (preview.conflicts.length > 0 ? 'warn' : 'success'));
  }

  /** 清除上周门诊预览 */
  function clearPrevWeekPreview() {
    prevWeekOutpatientPreview = null;
    prevWeekOutpatientLoaded = false;
    renderPanel();
    showToast('已清除上周门诊预览', 'info');
  }

  // ==================== 上周值班顺序导入 ====================

  /**
   * 拉取上周值班数据，重建值班顺序列表
   *
   * 值班周期 8 个位置对应的值班日：
   *   [0] 上周日 → [1]周一 → [2]周二 → [3]周三 → [4]周四 → [5]周五 → [6]周六 → [7]周日
   *
   * 匹配规则：
   *   1. 查找当天有「值班」班型的医生（am 或 pm 均可）
   *   2. 若当天多人值班，取第一个（去重后）
   *   3. 位置[0]的「上周日」需要额外拉取上上周日的数据
   */
  async function fetchAndPreviewPrevWeekDuty() {
    if (!state.doctors.length) { showToast('请先确保人员数据已加载', 'warn'); return; }

    // 上周一 ~ 上周日
    const lastMonday = new Date(weekInfo.monday);
    lastMonday.setDate(lastMonday.getDate() - 7);
    const lms = fmtLocalDate(lastMonday);
    const lme = getSunday(lms);

    // 上上周日（位置[0]需要）
    const prevSunday = new Date(lastMonday);
    prevSunday.setDate(prevSunday.getDate() - 1);
    const pss = fmtLocalDate(prevSunday);

    showToast('正在加载上周值班数据...', 'info');
    console.log('[排班辅助] 拉取上周值班: 主区间', lms, '~', lme, ' 上上周日', pss);

    try {
      const eids = state.doctors.map(d => d.id);

      // 并行拉取两段数据
      const [srMain, srPrevSun] = await Promise.all([
        ScheduleAPI.fetchEmpSchedules({ empIds: eids, from: lms, to: lme }),
        ScheduleAPI.fetchEmpSchedules({ empIds: eids, from: pss, to: pss })
      ]);

      const parseList = (raw) => {
        if (!raw || raw.error || !raw.data) return [];
        return Array.isArray(raw.data) ? raw.data : (raw.data.employees || raw.data.data || raw.data.rows || raw.data.list || []);
      };

      const mainScheds = parseList(srMain);
      const prevSunScheds = parseList(srPrevSun);
      const allScheds = [...mainScheds, ...prevSunScheds];

      console.log('[排班辅助] 上周值班原始数据:', mainScheds.length, '+', prevSunScheds.length, '条');

      // 构建日期 → 值班医生查找函数
      const findDutyDoctor = (targetDate) => {
        const candidates = [];
        for (let r of allScheds) {
          const eid = String(r.empId || r.employeeId || '');
          const wd = (r.workDate || r.date || '').slice(0, 10);
          if (wd !== targetDate || !eid) continue;
          // 注意：r.id 是排班记录ID，不是班型ID，不能用于 classIdMap 查找
          const cn = classIdMap[String(r.classId || r.scheduleClassId || '')] || r.name || r.className || '';
          // 宽松匹配：只要班型名包含"值班"即认为是值班记录（兼容"值班(大夜)"等变体）
          if (!cn || cn.indexOf('值班') === -1) continue;

          // 检查该医生是否在当前周名单中
          const doc = getDoctor(eid);
          if (!doc) continue;

          candidates.push({ doctorId: eid, name: doc.name });
        }
        // 去重（同一医生同一天可能有 am+pm 两条值班记录）
        const seen = new Set();
        const unique = [];
        for (let c of candidates) {
          if (!seen.has(c.doctorId)) { seen.add(c.doctorId); unique.push(c); }
        }
        console.log('[排班辅助]   🔍 日期' + targetDate + ' 值班候选人:', unique.length, '人',
          unique.map(function (c) { return c.name; }).join(', '));
        return unique.length > 0 ? unique[0] : null;
      };

      // 辅助：计算日期相对某周一的 dayIndex
      function getDayIndexFromMonday(dateStr, mondayStr) {
        const d = new Date(dateStr);
        const m = new Date(mondayStr);
        const diff = Math.round((d - m) / 86400000);
        return diff >= 0 && diff < 7 ? diff : -1;
      }

      // 8 天的日期数组
      const dutyDates = [];
      // [0] 上上周日 = pss
      dutyDates.push({ idx: 0, date: pss, label: '上周日(' + pss + ')' });
      // [1]~[7] 上周一 ~ 上周日
      for (let d = 0; d < 7; d++) {
        const dt = new Date(lastMonday);
        dt.setDate(lastMonday.getDate() + d);
        const ds = fmtLocalDate(dt);
        dutyDates.push({ idx: d + 1, date: ds, label: A.DAYS[d] + '(' + ds + ')' });
      }

      // 为每个位置匹配值班医生
      const order = new Array(8).fill('');
      const details = [];
      const missingDays = [];

      for (let dd of dutyDates) {
        const found = findDutyDoctor(dd.date);
        if (found) {
          order[dd.idx] = found.doctorId;
          details.push({ idx: dd.idx, dayLabel: dd.label, doctorId: found.doctorId, doctorName: found.name });
        } else {
          details.push({ idx: dd.idx, dayLabel: dd.label, doctorId: '', doctorName: '—' });
          missingDays.push(dd.label);
        }
      }

      prevWeekDutyOrderPreview = {
        sourceMonday: lms,
        order: order,
        details: details,
        missingDays: missingDays,
        foundCount: order.filter(id => id).length
      };

      console.log('[排班辅助] 值班顺序重建结果:', prevWeekDutyOrderPreview.foundCount, '/8, 缺失:', missingDays.join(', ') || '无');

      if (prevWeekDutyOrderPreview.foundCount === 0) {
        showToast('上周无值班数据可导入', 'warn');
      } else {
        const msg = `已重建 ${prevWeekDutyOrderPreview.foundCount}/8 位值班顺序` +
          (missingDays.length ? `，⚠️ ${missingDays.length} 天未匹配到值班医生` : '');
        showToast(msg, missingDays.length ? 'warn' : 'success');
      }
      renderPanel();
    } catch (err) {
      console.error('[排班辅助] 拉取上周值班失败:', err.message);
      showToast('拉取失败: ' + err.message, 'error');
    }
  }

  /** 将预览的上周值班顺序应用到当前 state.dutyOrder */
  function applyPrevWeekDutyOrder() {
    if (!prevWeekDutyOrderPreview) { showToast('请先导入上周值班顺序', 'warn'); return; }
    const preview = prevWeekDutyOrderPreview;

    if (!state.dutyOrder) state.dutyOrder = [];
    while (state.dutyOrder.length < 8) state.dutyOrder.push('');

    // 仅应用有值的槽位，保留其他为默认或留空
    let applied = 0;
    for (let i = 0; i < 8; i++) {
      if (preview.order[i]) {
        state.dutyOrder[i] = preview.order[i];
        applied++;
      }
    }

    syncStateToBackground();
    renderPanel();

    const msg = `已应用 ${applied}/8 位值班顺序` +
      (preview.missingDays.length ? `，${preview.missingDays.length} 天需手动补充` : '');
    showToast(msg, preview.missingDays.length ? 'warn' : 'success');
  }

  /** 清除上周值班预览 */
  function clearPrevWeekDutyPreview() {
    prevWeekDutyOrderPreview = null;
    renderPanel();
    showToast('已清除上周值班顺序预览', 'info');
  }

  // ==================== 业务操作函数 ====================
  function toggleWorkday(d) { if (!state.workdayConfig) state.workdayConfig = [true, true, true, true, true, false, false]; state.workdayConfig[d] = !state.workdayConfig[d]; renderPanel(); syncStateToBackground(); }
  function updateMentor(traineeId, mentorId) {
    const doc = getDoctor(traineeId);
    if (!doc) return;
    doc.mentorId = mentorId || null;
    syncStateToBackground();
    renderPanel();
  }
  function updateGeneral(di, sl, did) { if (!state.outpatientGeneral[di]) state.outpatientGeneral[di] = { am: null, pm: null }; state.outpatientGeneral[di][sl] = did || null; syncStateToBackground(); applyToPageTable(); }
  function addGaoxin() { if (!state.outpatientGaoxin) state.outpatientGaoxin = []; state.outpatientGaoxin.push({ dayIdx: null, doctorId: null }); renderPanel(); }
  function updateGaoxin(i, f, v) { if (!state.outpatientGaoxin) state.outpatientGaoxin = []; if (!state.outpatientGaoxin[i]) state.outpatientGaoxin[i] = { dayIdx: null, doctorId: null }; state.outpatientGaoxin[i][f] = (v || v === 0) ? v : null; syncStateToBackground(); applyToPageTable(); }
  function removeGaoxin(i) { state.outpatientGaoxin.splice(i, 1); renderPanel(); }
  function addZitong() { if (!state.outpatientZitong) state.outpatientZitong = []; state.outpatientZitong.push({ dayIdx: null, doctorId: null }); renderPanel(); }
  function updateZitong(i, f, v) { if (!state.outpatientZitong) state.outpatientZitong = []; if (!state.outpatientZitong[i]) state.outpatientZitong[i] = { dayIdx: null, doctorId: null }; state.outpatientZitong[i][f] = (v || v === 0) ? v : null; syncStateToBackground(); applyToPageTable(); }
  function removeZitong(i) { state.outpatientZitong.splice(i, 1); renderPanel(); }
  function addSimple() { if (!state.outpatientSimple) state.outpatientSimple = []; state.outpatientSimple.push({ dayIdx: null, doctorId: null, slot: null }); renderPanel(); }
  function updateSimple(i, f, v) { if (!state.outpatientSimple) state.outpatientSimple = []; if (!state.outpatientSimple[i]) state.outpatientSimple[i] = { dayIdx: null, doctorId: null, slot: null }; state.outpatientSimple[i][f] = (v || v === 0) ? v : null; syncStateToBackground(); applyToPageTable(); }
  function removeSimple(i) { state.outpatientSimple.splice(i, 1); renderPanel(); }

  async function clearOutpatient() {
    if (!(await showModal({ title: '清空门诊', message: '清空所有门诊安排？', icon: 'delete' }))) return;
    state.outpatientGeneral = {}; state.outpatientSimple = []; state.outpatientGaoxin = []; state.outpatientZitong = [];
    for (let d = 0; d < 7; d++) state.outpatientGeneral[d] = { am: null, pm: null };
    renderPanel(); syncStateToBackground(); showToast('门诊安排已清空', 'success');
  }

  function exportOutpatientJSON() {
    const data = {
      version: 1, type: 'outpatient', exportedAt: new Date().toISOString(),
      outpatientGeneral: state.outpatientGeneral || {},
      outpatientSimple: state.outpatientSimple || [],
      outpatientGaoxin: state.outpatientGaoxin || [],
      outpatientZitong: state.outpatientZitong || []
    };
    downloadJSON(data, `门诊安排_${new Date().toISOString().slice(0, 10)}.json`);
    showToast('门诊配置已导出', 'success');
  }

  function importOutpatientJSON() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json';
    input.addEventListener('change', function (e) {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = async function (ev) {
        try {
          const data = JSON.parse(ev.target.result);
          if (data.type !== 'outpatient' || !data.version) { showToast('无效的门诊配置文件', 'error'); return; }
          if (!(await showModal({ title: '导入门诊', message: '导入门诊安排？当前数据将被替换。', icon: 'file_download' }))) return;
          state.outpatientGeneral = data.outpatientGeneral || {};
          state.outpatientSimple = data.outpatientSimple || [];
          state.outpatientGaoxin = data.outpatientGaoxin || [];
          state.outpatientZitong = data.outpatientZitong || [];
          renderPanel(); syncStateToBackground();
          showToast('门诊安排已导入', 'success');
        } catch (err) { showToast('JSON解析失败: ' + err.message, 'error'); }
      };
      reader.readAsText(file, 'utf-8');
    });
    input.click();
  }
  function updateSpecial(did, di, sl, t) { if (!state.special) state.special = {}; if (!state.special[did]) state.special[did] = {}; if (!state.special[did][di]) state.special[did][di] = { am: null, pm: null }; state.special[did][di][sl] = t || null; syncStateToBackground(); applyToPageTable(); }
  function toggleAllSpecial(on, did) { document.querySelectorAll(`.sh-special-chk[data-doc="${did}"]`).forEach(cb => cb.checked = on); }
  function toggleWorkdaySpecial(did) { document.querySelectorAll(`.sh-special-chk[data-doc="${did}"]`).forEach(cb => { cb.checked = (state.workdayConfig || [])[+cb.dataset.day]; }); }
  function toggleSlotSpecial(did, slot) { document.querySelectorAll(`.sh-special-chk[data-doc="${did}"][data-slot="${slot}"]`).forEach(cb => { cb.checked = true; }); }
  function batchSpecial(did) { const t = document.getElementById('sh-batch-special-type')?.value; if (!t) { showToast('请选择类型', 'warn'); return; } const chk = [...document.querySelectorAll(`.sh-special-chk[data-doc="${did}"]:checked`)]; if (!chk.length) { showToast('请勾选时段', 'warn'); return; } if (!state.special) state.special = {}; if (!state.special[did]) state.special[did] = {}; chk.forEach(cb => { const di = +cb.dataset.day, sl = cb.dataset.slot; if (!state.special[did][di]) state.special[did][di] = { am: null, pm: null }; state.special[did][di][sl] = t; }); renderSpecialDocForm(); syncStateToBackground(); applyToPageTable(); showToast(`已应用 ${t} ×${chk.length}`, 'success'); }
  function batchClearSpecial(did) { const chk = [...document.querySelectorAll(`.sh-special-chk[data-doc="${did}"]:checked`)]; if (!chk.length) { showToast('请勾选时段', 'warn'); return; } if (!state.special) state.special = {}; if (!state.special[did]) state.special[did] = {}; chk.forEach(cb => { const di = +cb.dataset.day, sl = cb.dataset.slot; if (!state.special[did][di]) state.special[did][di] = { am: null, pm: null }; state.special[did][di][sl] = null; }); renderSpecialDocForm(); syncStateToBackground(); applyToPageTable(); showToast(`已清除 ×${chk.length}`, 'success'); }
  function updateDutyOrder(i, did) { if (!state.dutyOrder) state.dutyOrder = []; while (state.dutyOrder.length < 8) state.dutyOrder.push(''); state.dutyOrder[i] = did || ''; renderPanel(); syncStateToBackground(); }
  function resetDutyOrder() { state.dutyOrder = A.buildDefaultDutyOrder(state.doctors); renderPanel(); }
  async function runAutoDuty() { const f = (state.dutyOrder || []).filter(id => id && getDoctor(id)).length; if (!f) { showToast('请先设置值班序列', 'warn'); return; } if (!(await showModal({ title: '自动排班', message: '执行自动排班？已有安排不会被覆盖。', icon: 'manage_history' }))) return; const r = A.computeAutoDuty(state); state.dutyAssigned = r.dutyAssigned; state.baiban1Flags = r.baiban1Flags; renderPanel(); syncStateToBackground(); const c = state.baiban1Flags.filter(fl => fl.isConflict).length; showToast(c ? `排班完成！${c}个冲突需处理` : '排班完成，无冲突！', c ? 'warn' : 'success'); }
  async function clearDuty() { if (!(await showModal({ title: '清空值班', message: '清空所有值班安排？', icon: 'delete' }))) return; state.dutyAssigned = {}; state.baiban1Flags = []; renderPanel(); }
  async function quickBaiban1(di, sl) { const cand = A.getBaiban1Candidates(state, di, sl); if (!cand.length) { showToast('无可用医生', 'warn'); return; } const choice = await showModal({ title: '分配白班1', message: `为 ${A.DAYS[di]}${A.SLOT_LABELS[sl]} 选择白班1医生：`, icon: 'personal_injury', type: 'select', selectOptions: cand.map((d, i) => ({ value: String(i), label: `${i + 1}. ${d.name}（#${d.number}）` })), okLabel: '确定', cancelLabel: '取消' }); if (choice === null) return; const idx = +choice; const doc = cand[idx]; if (!state.dutyAssigned) state.dutyAssigned = {}; if (!state.dutyAssigned[doc.id]) state.dutyAssigned[doc.id] = {}; if (!state.dutyAssigned[doc.id][di]) state.dutyAssigned[doc.id][di] = { am: null, pm: null }; state.dutyAssigned[doc.id][di][sl] = '白班1'; state.baiban1Flags = A.resolveConflict(state.baiban1Flags, di, sl, doc.id, doc.name); renderPanel(); syncStateToBackground(); }
  function fillEmpty() { const r = A.computeFillEmpty(state); state.dutyAssigned = r.dutyAssigned; renderPanel(); syncStateToBackground(); showToast(`已填补 ${r.count} 个空缺`, 'success'); }
  function syncTrainees() { const r = A.computeTraineeSync(state); state.dutyAssigned = r.dutyAssigned; state.traineeFlags = r.traineeFlags; renderPanel(); syncStateToBackground(); showToast('规培生已同步导师排班', 'success'); }

  // ==================== JSON 导入/导出 ====================
  function downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  function exportFullScheduleJSON() {
    const data = {
      version: 1, type: 'fullSchedule', exportedAt: new Date().toISOString(),
      doctors: state.doctors.map(d => ({
        id: d.id, name: d.name, type: d.type, number: d.number,
        mentorId: d.mentorId || null,
        training: d.training || false,
        onLeave: d.onLeave || false,
        noDutyDays: d.noDutyDays || [],
        dutyDays: d.dutyDays || []
      })),
      outpatientGeneral: state.outpatientGeneral || {},
      outpatientSimple: state.outpatientSimple || [],
      outpatientGaoxin: state.outpatientGaoxin || [],
      outpatientZitong: state.outpatientZitong || [],
      workdayConfig: state.workdayConfig || [true, true, true, true, true, false, false],
      special: state.special || {},
      dutyAssigned: state.dutyAssigned || {},
      baiban1Flags: state.baiban1Flags || [],
      traineeFlags: state.traineeFlags || {}
    };
    downloadJSON(data, `完整排班表_${new Date().toISOString().slice(0, 10)}.json`);
    showToast('完整配置已导出', 'success');
  }

  function importFullScheduleJSON() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json';
    input.addEventListener('change', function (e) {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = async function (ev) {
        try {
          const data = JSON.parse(ev.target.result);
          if (data.type !== 'fullSchedule' || !data.version) { showToast('无效的排班配置文件', 'error'); return; }
          if (!(await showModal({ title: '导入排班', message: '导入完整排班表？当前所有排班数据将被替换。', icon: 'file_download' }))) return;
          if (data.doctors && data.doctors.length > 0) {
            state.doctors = data.doctors.map(d => ({
              id: d.id, name: d.name, type: d.type, number: d.number,
              mentorId: d.mentorId || null,
              training: d.training || false,
              onLeave: d.onLeave || false,
              noDutyDays: d.noDutyDays || [],
              dutyDays: d.dutyDays || []
            }));
          }
          state.outpatientGeneral = data.outpatientGeneral || {};
          state.outpatientSimple = data.outpatientSimple || [];
          state.outpatientGaoxin = data.outpatientGaoxin || [];
          state.outpatientZitong = data.outpatientZitong || [];
          state.workdayConfig = data.workdayConfig || [true, true, true, true, true, false, false];
          state.special = data.special || {};
          state.dutyAssigned = data.dutyAssigned || {};
          state.baiban1Flags = data.baiban1Flags || [];
          state.traineeFlags = data.traineeFlags || {};
          renderPanel(); syncStateToBackground();
          showToast('完整排班表已导入', 'success');
        } catch (err) { showToast('JSON解析失败: ' + err.message, 'error'); }
      };
      reader.readAsText(file, 'utf-8');
    });
    input.click();
  }

  // ==================== 启动 ====================
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
