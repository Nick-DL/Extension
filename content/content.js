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
  let weekInfo = { year: new Date().getFullYear(), week: 1, monday: '' };
  let dragSrcIdx = null, dragOpacityTimer = null;
  let prevWeekOutpatientPreview = null;  // { outpatientGeneral, outpatientGaoxin, outpatientZitong, conflicts:[] }
  let prevWeekOutpatientLoaded = false;

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
    }).catch(err => { console.error('[排班辅助] 数据加载失败:', err.message); showToast('数据加载失败', 'error'); });
  }

  function onDisabled() {
    togglePanel(false); document.getElementById('sh-quick-entry').classList.add('hidden');
    if (restoreFetch) { restoreFetch(); restoreFetch = null; }
    removeClassColorBars(); showToast('排班辅助插件已关闭', 'info');
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
   * 根据ISO周数计算近似周一日期
   */
  function getMondayOfISOWeek(year, week) {
    // ISO周: 第1周是包含该年第一个周四的周
    const jan4 = new Date(year, 0, 4);
    const jan4Dow = jan4.getDay() || 7; // 周日=7
    const firstMonday = new Date(jan4);
    firstMonday.setDate(jan4.getDate() - (jan4Dow - 1));
    const monday = new Date(firstMonday);
    monday.setDate(firstMonday.getDate() + (week - 1) * 7);
    return monday.toISOString().slice(0, 10);
  }

  function getWeekInfo(date) {
    const d = new Date(date); const dow = d.getDay();
    const offset = dow === 0 ? -6 : 1 - dow;
    const mon = new Date(d); mon.setDate(d.getDate() + offset);
    const ys = new Date(mon.getFullYear(), 0, 1);
    const wn = Math.ceil(((mon - ys) / 86400000 + ys.getDay() + 1) / 7);
    return { year: mon.getFullYear(), week: wn, monday: mon.toISOString().slice(0, 10) };
  }
  function getSunday(ms) { const d = new Date(ms); d.setDate(d.getDate() + 6); return d.toISOString().slice(0, 10); }

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
    for (let d = 0; d < 7; d++) state.outpatientGeneral[d] = { am: null, pm: null };
    const m = new Date(weekInfo.monday); const d2i = {};
    for (let d = 0; d < 7; d++) { const dt = new Date(m); dt.setDate(m.getDate() + d); d2i[dt.toISOString().slice(0, 10)] = d; }
    console.log('[排班辅助] 日期映射(d2i):', JSON.stringify(d2i));

    var skippedNoEid = 0, skippedNoCn = 0, skippedNoDate = 0, parsedOk = 0;
    var cnMismatchSamples = []; // 记录classIdMap找不到的样本
    for (let r of scheds) {
      const eid = String(r.empId || r.employeeId || ''), wd = (r.workDate || r.date || '').slice(0, 10);
      const rawId = r.id || r.classId || r.scheduleClassId || '';
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
      if (A.CLINIC_TYPES.includes(cn)) {
        if (cn === '总院门诊') { if (!state.outpatientGeneral[di]) state.outpatientGeneral[di] = { am: null, pm: null }; state.outpatientGeneral[di][sl] = eid; }
        else if (cn === '高新门诊') { if (!state.outpatientGaoxin.find(a => a.dayIdx === di && a.doctorId === eid)) state.outpatientGaoxin.push({ dayIdx: di, doctorId: eid }); }
        else if (cn === '梓潼门诊') { if (!state.outpatientZitong.find(a => a.dayIdx === di && a.doctorId === eid)) state.outpatientZitong.push({ dayIdx: di, doctorId: eid }); }
      } else if (A.SPECIAL_TYPES.includes(cn)) {
        if (!state.special[eid]) state.special[eid] = {}; if (!state.special[eid][di]) state.special[eid][di] = { am: null, pm: null };
        state.special[eid][di][sl] = cn;
      } else {
        if (!state.dutyAssigned[eid]) state.dutyAssigned[eid] = {}; if (!state.dutyAssigned[eid][di]) state.dutyAssigned[eid][di] = { am: null, pm: null };
        state.dutyAssigned[eid][di][sl] = cn;
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
    const pms = pm.toISOString().slice(0, 10);
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
      d2i[dt.toISOString().slice(0, 10)] = d;
    }

    let outGeneralCount = 0, outGaoxinCount = 0, outZitongCount = 0;
    let dutyCount = 0;

    for (let r of scheds) {
      const eid = String(r.empId || r.employeeId || '');
      const wd = (r.workDate || r.date || '').slice(0, 10);
      const cn = classIdMap[String(r.id || r.classId || r.scheduleClassId || '')] || r.name || r.className || '';
      const di = d2i[wd];
      if (di === undefined || !eid || !cn) continue;

      const sl = r.segment ? (r.segment === 1 ? 'am' : 'pm') : (r.slot || r.ampm || r.timeSlot || 'am');

      // 检查当前周是否有同名医生（ID匹配）
      const docExists = state.doctors.some(d => d.id === eid);
      if (!docExists) continue;

      // 门诊数据预置
      if (cn === '总院门诊') {
        if (!state.outpatientGeneral[di]) state.outpatientGeneral[di] = { am: null, pm: null };
        if (!state.outpatientGeneral[di][sl]) {
          state.outpatientGeneral[di][sl] = eid;
          outGeneralCount++;
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
        // 仅填充未被门诊占用的时段
        const genDay = state.outpatientGeneral[di] || { am: null, pm: null };
        if (!genDay[sl] || genDay[sl] !== eid) {
          state.dutyAssigned[eid][di][sl] = cn;
          dutyCount++;
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
  function restoreOriginalData() {
    if (!originalData) { showToast('没有可恢复的备份数据', 'warn'); return; }
    if (!confirm('确定恢复为操作前的原始数据？')) return;
    state.doctors = JSON.parse(JSON.stringify(originalData.doctors || []));
    state.outpatientGeneral = JSON.parse(JSON.stringify(originalData.outpatientGeneral || {}));
    state.outpatientSimple = JSON.parse(JSON.stringify(originalData.outpatientSimple || []));
    state.outpatientGaoxin = JSON.parse(JSON.stringify(originalData.outpatientGaoxin || []));
    state.outpatientZitong = JSON.parse(JSON.stringify(originalData.outpatientZitong || []));
    state.special = JSON.parse(JSON.stringify(originalData.special || {}));
    state.dutyAssigned = JSON.parse(JSON.stringify(originalData.dutyAssigned || {}));
    state.workdayConfig = JSON.parse(JSON.stringify(originalData.workdayConfig || [true,true,true,true,true,false,false]));
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
  function applyToPageTable() { /* TODO: 适配实际页面DOM */ }

  // ==================== 提交 ====================
  async function submitAllChanges() {
    if (!confirm('确定提交所有排班修改？\n提交成功后请刷新页面查看。')) return;
    try {
      const bd = ScheduleAPI.buildBatchData(state, classMap, locationId, weekInfo.monday);
      if (!bd.length) { showToast('没有需要提交的修改', 'warn'); return; }
      const resp = await ScheduleAPI.appendUsualClass(bd);
      if (resp.error) { showToast('提交失败: ' + (resp.message || '未知错误'), 'error'); return; }
      showToast(`成功提交 ${bd.length} 条排班记录！请刷新页面查看。`, 'success');
      if (restoreFetch) { restoreFetch(); restoreFetch = null; }
      chrome.runtime.sendMessage({ type: 'SET_INTERCEPTING', intercepting: false });
      setTimeout(() => { if (confirm('排班已提交成功，是否刷新页面？')) window.location.reload(); }, 1500);
    } catch (err) { showToast('提交异常: ' + err.message, 'error'); }
  }

  // ==================== DOM 注入 ====================
  function injectQuickEntry() {
    if (document.getElementById('sh-quick-entry')) return;
    const e = document.createElement('div'); e.id = 'sh-quick-entry'; e.className = 'hidden'; e.textContent = '排班辅助'; e.title = '点击打开排班辅助面板';
    e.addEventListener('click', () => togglePanel(true)); document.body.appendChild(e);
  }
  function injectToastContainer() {
    if (document.getElementById('sh-toast-container')) return;
    const c = document.createElement('div'); c.id = 'sh-toast-container'; c.className = 'sh-toast-container'; document.body.appendChild(c);
  }
  function injectPanel() {
    if (document.getElementById('scheduling-helper-panel')) return;
    const p = document.createElement('div'); p.id = 'scheduling-helper-panel';
    p.innerHTML = `<div class="sh-panel-header" id="sh-panel-header"><span class="sh-title">🏥 排班辅助</span><div class="sh-actions"><button class="sh-btn" id="sh-btn-minimize" title="最小化">−</button><button class="sh-btn" id="sh-btn-close" title="关闭">✕</button></div></div><div class="sh-steps-bar" id="sh-steps-bar"><div class="sh-step-item active" data-action="goToStep" data-step="1"><span class="sh-step-num">1</span>人员</div><div class="sh-step-item" data-action="goToStep" data-step="2"><span class="sh-step-num">2</span>门诊</div><div class="sh-step-item" data-action="goToStep" data-step="3"><span class="sh-step-num">3</span>特殊</div><div class="sh-step-item" data-action="goToStep" data-step="4"><span class="sh-step-num">4</span>值班</div><div class="sh-step-item" data-action="goToStep" data-step="5"><span class="sh-step-num">5</span>确认</div></div><div class="sh-panel-body" id="sh-panel-body"></div>`;
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
    let dragging = false, sx, sy, sl, st;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return; dragging = true;
      sx = e.clientX; sy = e.clientY; const r = target.getBoundingClientRect(); sl = r.left; st = r.top;
      target.style.transition = 'none'; document.body.style.userSelect = 'none';
      const mm = (ev) => { if (!dragging) return; target.style.left = (sl + ev.clientX - sx) + 'px'; target.style.top = (st + ev.clientY - sy) + 'px'; target.style.right = 'auto'; };
      const mu = () => { dragging = false; target.style.transition = ''; document.body.style.userSelect = ''; document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); };
      document.addEventListener('mousemove', mm); document.addEventListener('mouseup', mu);
    });
  }

  // ==================== 面板控制 ====================
  function togglePanel(show) { const p = document.getElementById('scheduling-helper-panel'); if (!p) return; panelVisible = show; if (show) { p.classList.add('visible'); if (isMinimized) toggleMinimize(); goToStep(state.currentStep); } else { p.classList.remove('visible'); } }
  function toggleMinimize() { const p = document.getElementById('scheduling-helper-panel'), b = document.getElementById('sh-panel-body'), s = document.getElementById('sh-steps-bar'); if (!p) return; isMinimized = !isMinimized; if (isMinimized) { p.classList.add('minimized'); b.style.display = 'none'; s.style.display = 'none'; } else { p.classList.remove('minimized'); b.style.display = ''; s.style.display = ''; } }

  function goToStep(n) { state.currentStep = n; renderStepsBar(); renderPanel(); }
  function renderStepsBar() {
    document.querySelectorAll('#sh-steps-bar .sh-step-item').forEach(item => {
      const s = +item.dataset.step; item.classList.remove('active', 'done');
      if (s === state.currentStep) item.classList.add('active'); else if (s < state.currentStep) item.classList.add('done');
    });
  }

  // ==================== 面板渲染 ====================
  function renderPanel() { const b = document.getElementById('sh-panel-body'); if (!b) return; switch (state.currentStep) { case 1: renderS1(b); break; case 2: renderS2(b); break; case 3: renderS3(b); break; case 4: renderS4(b); break; case 5: renderS5(b); break; } }

  // ===== S1: 人员 =====
  function renderS1(body) {
    const docs = state.doctors;
    let h = ``;
    // ---- 工作周选择器（通过操作页面Ant Design picker DOM） ----
    h += `<div class="sh-subtitle">📅 工作周切换</div>`;
    h += `<div class="sh-week-picker">`;
    h += `<button class="sh-btn-action sh-btn-outline sh-btn-sm" data-action="goPrevWeek" title="上一周">◀ 上一周</button>`;
    h += `<span style="margin:0 6px;font-weight:600;font-size:13px;white-space:nowrap;">${weekInfo.year}年 第${weekInfo.week}周</span>`;
    h += `<button class="sh-btn-action sh-btn-outline sh-btn-sm" data-action="goNextWeek" title="下一周">下一周 ▶</button>`;
    h += `</div>`;
    h += `<div class="sh-week-picker" style="margin-top:6px;">`;
    h += `<span style="font-size:11px;color:#666;">跳转到第</span>`;
    h += `<input type="number" id="sh-week-num" value="${weekInfo.week}" min="1" max="53" style="width:55px;text-align:center;" title="输入周数">`;
    h += `<span style="font-size:11px;color:#666;">周</span>`;
    h += `<button class="sh-btn-action sh-btn-primary sh-btn-xs" data-action="confirmWeek">GO</button>`;
    h += `</div>`;
    h += `<div class="sh-help-text" style="margin-top:4px;">周一 ${weekInfo.monday} · 切换后将自动刷新页面数据</div>`;
    // 人员列表
    h += `<div class="sh-divider"></div>`;
    h += `<div class="sh-info-bar info">💡 人员数据从系统自动加载。<br>仅显示排班类别为<b>"医疗"</b>和<b>"规培"</b>的人员。</div>`;
    h += `<div class="sh-subtitle">📋 人员列表 <span style="font-size:10px;color:#999;font-weight:400;">(${docs.length}人)</span></div>`;
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
        rightHtml = `<span style="font-size:10px;color:#999;white-space:nowrap;">导师：<select data-action="updateMentor" data-doc="${d.id}" style="font-size:10px;padding:1px 4px;border:1px solid #d9d9d9;border-radius:3px;max-width:120px;" title="指定导师">
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
    h += `<div class="sh-subtitle">📅 工作日 / 节假日设定</div>`;
    h += `<div class="sh-help-text">点击按钮切换：<span style="color:#1677ff;">蓝色=工作日</span>，灰色=节假日。</div>`;
    h += `<div class="sh-workday-row">`;
    for (let d = 0; d < 7; d++) { const wd = (state.workdayConfig || [])[d]; h += `<button class="sh-btn-action sh-btn-sm ${wd ? 'sh-btn-primary' : 'sh-btn-outline'}" data-action="toggleWorkday" data-day="${d}">${A.DAYS[d]}</button>`; }
    h += `</div>`;
    h += `<button class="sh-btn-action sh-btn-primary sh-btn-block" data-action="goToStep" data-step="2" style="margin-top:12px;">下一步 → 门诊安排</button>`;
    body.innerHTML = h;
  }

  // ===== S2: 门诊 =====
  function renderS2(body) {
    let h = `<div class="sh-info-bar info">💡 四类门诊分别管理。<br>· 总院门诊 每天上、下午<br>· 简易门诊 时间不固定（表格中显示为总院门诊）<br>· 高新门诊 周内上午<br>· 梓潼门诊 周三上午</div>`;

    // ---- 导入上周门诊区域 ----
    h += renderPrevWeekOutpatientSection();

    // 总院门诊
    h += `<div class="sh-subtitle sh-clinic-title-general">🏥 总院门诊</div>`;
    for (let d = 0; d < 7; d++) { const gen = state.outpatientGeneral[d] || { am: null, pm: null }; h += `<div style="margin-bottom:4px;font-size:11px;padding:4px 6px;background:#fafafa;border-radius:4px;"><strong>${A.DAYS[d]}</strong><div class="sh-form-row">`;
      for (let s of A.SLOTS) h += `<div style="flex:1;"><span style="font-size:9px;color:#999;">${A.SLOT_LABELS[s]}</span><select data-action="updateGeneral" data-day="${d}" data-slot="${s}" style="font-size:10px;"><option value="">—</option>${docOptsHtmlSelected(gen[s])}</select></div>`; h += `</div></div>`; }
    // 高新门诊
    h += `<div class="sh-divider"></div><div class="sh-subtitle sh-clinic-title-gaoxin">🏥 高新门诊 <span style="font-size:10px;color:#999;font-weight:400;">（仅上午）</span></div><div id="sh-gaoxin-rows">`;
    (state.outpatientGaoxin || []).forEach((it, i) => { h += renderGxRow(i, it); });
    h += `</div><button class="sh-btn-action sh-btn-outline sh-btn-sm sh-btn-block" data-action="addGaoxin">➕ 添加高新门诊</button>`;
    // 梓潼门诊
    h += `<div class="sh-divider"></div><div class="sh-subtitle sh-clinic-title-zitong">🏥 梓潼门诊 <span style="font-size:10px;color:#999;font-weight:400;">（仅上午 · 每两周周三）</span></div><div id="sh-zitong-rows">`;
    (state.outpatientZitong || []).forEach((it, i) => { h += renderZtRow(i, it); });
    h += `</div><button class="sh-btn-action sh-btn-outline sh-btn-sm sh-btn-block" data-action="addZitong">➕ 添加梓潼门诊</button>`;
    // 简易门诊
    h += `<div class="sh-divider"></div><div class="sh-subtitle sh-clinic-title-general">🏥 简易门诊 <span style="font-size:10px;color:#999;font-weight:400;">（表格中显示为总院门诊）</span></div><div id="sh-simple-rows">`;
    (state.outpatientSimple || []).forEach((it, i) => { h += renderSmRow(i, it); });
    h += `</div><button class="sh-btn-action sh-btn-outline sh-btn-sm sh-btn-block" data-action="addSimple">➕ 添加简易门诊</button>`;
    // 导出/导入/清空按钮
    h += `<div class="sh-divider"></div><div class="sh-btn-group">`;
    h += `<button class="sh-btn-action sh-btn-outline sh-btn-sm" data-action="exportOutpatient">📤 导出配置</button>`;
    h += `<button class="sh-btn-action sh-btn-outline sh-btn-sm" data-action="importOutpatient">📥 导入配置</button>`;
    h += `<button class="sh-btn-action sh-btn-outline sh-btn-sm" data-action="clearOutpatient">🗑 清空门诊</button>`;
    h += `</div>`;
    h += `<div class="sh-nav-row"><button class="sh-btn-action sh-btn-outline" data-action="goToStep" data-step="1">← 上一步</button><button class="sh-btn-action sh-btn-primary" data-action="goToStep" data-step="3">下一步 → 特殊安排</button></div>`;
    body.innerHTML = h;
  }
  function renderGxRow(i, it) { it = it || {}; return `<div class="sh-form-row" style="align-items:center;margin-bottom:2px;"><select data-action="updateGaoxin" data-idx="${i}" data-field="dayIdx" style="flex:1;font-size:10px;"><option value="">选择日期</option>${[0,1,2,3,4].map(d=>`<option value="${d}" ${it.dayIdx===d?'selected':''}>${A.DAYS[d]}</option>`).join('')}</select><select data-action="updateGaoxin" data-idx="${i}" data-field="doctorId" style="flex:1;font-size:10px;"><option value="">选择医生</option>${docOptsHtmlSelected(it.doctorId||'')}</select><button class="sh-btn-action sh-btn-danger sh-btn-xs" data-action="removeGaoxin" data-idx="${i}">✕</button></div>`; }
  function renderZtRow(i, it) { it = it || {}; return `<div class="sh-form-row" style="align-items:center;margin-bottom:2px;"><select data-action="updateZitong" data-idx="${i}" data-field="dayIdx" style="flex:1;font-size:10px;"><option value="">选择日期</option>${[0,1,2,3,4].map(d=>`<option value="${d}" ${it.dayIdx===d?'selected':''}>${A.DAYS[d]}</option>`).join('')}</select><select data-action="updateZitong" data-idx="${i}" data-field="doctorId" style="flex:1;font-size:10px;"><option value="">选择医生</option>${docOptsHtmlSelected(it.doctorId||'')}</select><button class="sh-btn-action sh-btn-danger sh-btn-xs" data-action="removeZitong" data-idx="${i}">✕</button></div>`; }
  function renderSmRow(i, it) { it = it || {}; return `<div class="sh-form-row" style="align-items:center;margin-bottom:2px;"><select data-action="updateSimple" data-idx="${i}" data-field="dayIdx" style="flex:1;font-size:10px;"><option value="">日期</option>${[0,1,2,3,4,5,6].map(d=>`<option value="${d}" ${it.dayIdx===d?'selected':''}>${A.DAYS[d]}</option>`).join('')}</select><select data-action="updateSimple" data-idx="${i}" data-field="slot" style="flex:0.7;font-size:10px;"><option value="">时段</option><option value="am" ${it.slot==='am'?'selected':''}>上午</option><option value="pm" ${it.slot==='pm'?'selected':''}>下午</option></select><select data-action="updateSimple" data-idx="${i}" data-field="doctorId" style="flex:1;font-size:10px;"><option value="">医生</option>${docOptsHtmlSelected(it.doctorId||'')}</select><button class="sh-btn-action sh-btn-danger sh-btn-xs" data-action="removeSimple" data-idx="${i}">✕</button></div>`; }

  // ===== 上周门诊导入预览渲染 =====
  function renderPrevWeekOutpatientSection() {
    let s = `<div class="sh-divider"></div>`;
    s += `<div class="sh-subtitle" style="color:#1677ff;">📥 从上周导入门诊</div>`;

    if (!prevWeekOutpatientLoaded || !prevWeekOutpatientPreview) {
      const prevMonday = new Date(weekInfo.monday);
      prevMonday.setDate(prevMonday.getDate() - 7);
      const prevLabel = `${prevMonday.getFullYear()}年 第${getWeekInfo(prevMonday).week}周`;
      s += `<div class="sh-help-text">点击下方按钮，将 <b>${prevLabel}</b> 的门诊安排（总院门诊、高新门诊、梓潼门诊）导入预览。</div>`;
      s += `<button class="sh-btn-action sh-btn-primary sh-btn-sm sh-btn-block" data-action="fetchPrevWeekOutpatient">📥 导入上一周门诊</button>`;
      return s;
    }

    const preview = prevWeekOutpatientPreview;
    const prevLabel = `${new Date(preview.sourceMonday).getFullYear()}年 第${getWeekInfo(new Date(preview.sourceMonday)).week}周`;

    // 状态标签
    s += `<div class="sh-info-bar success" style="margin-bottom:6px;">✅ 已加载 ${prevLabel} 共 <b>${preview.totalCount}</b> 条门诊记录</div>`;

    // 冲突警告
    if (preview.conflicts.length > 0) {
      s += `<div class="sh-info-bar warn" style="margin-bottom:8px;">`;
      s += `⚠️ 检测到 <b>${preview.conflicts.length}</b> 个时段存在多个总院门诊：`;
      s += `<ul style="margin:4px 0 0 14px;font-size:10px;">`;
      for (let c of preview.conflicts) {
        s += `<li>${c.message}</li>`;
      }
      s += `</ul>`;
      s += `💡 应用时自动将第1位设为总院门诊，第2位设为简易门诊。`;
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
    s += `<button class="sh-btn-action sh-btn-success sh-btn-sm" data-action="applyPrevWeekOutpatient" style="flex:2;">✅ 应用到本周</button>`;
    s += `<button class="sh-btn-action sh-btn-outline sh-btn-sm" data-action="fetchPrevWeekOutpatient" style="flex:1;">🔄 重新加载</button>`;
    s += `<button class="sh-btn-action sh-btn-outline sh-btn-sm" data-action="clearPrevWeekPreview" style="flex:1;">✕ 清除</button>`;
    s += `</div>`;

    return s;
  }

  // ===== S3: 特殊安排 =====
  function renderS3(body) {
    let h = `<div class="sh-info-bar info">💡 为每位医生设置特殊安排。<br>选择医生，勾选时段，再选择类型，可为不同的时间段批量应用班型。<br>特殊安排包括：产假、事假、休、二线、培训、开会、医疗保障、脱产学习。</div>`;
    h += `<label>👨‍⚕️ 选择医生</label><select id="sh-special-doc" data-action="renderSpecialForm"><option value="">— 请选择 —</option>${state.doctors.map(d=>`<option value="${d.id}">${d.name} (#${d.number})</option>`).join('')}</select><div id="sh-special-form" style="margin-top:8px;"></div>`;
    h += `<div class="sh-nav-row"><button class="sh-btn-action sh-btn-outline" data-action="goToStep" data-step="2">← 上一步</button><button class="sh-btn-action sh-btn-primary" data-action="goToStep" data-step="4">下一步 → 值班排班</button></div>`;
    body.innerHTML = h;
  }
  function renderSpecialDocForm() {
    const sel = document.getElementById('sh-special-doc'), fd = document.getElementById('sh-special-form'); if (!sel || !fd) return;
    const did = sel.value; if (!did) { fd.innerHTML = ''; return; }
    const doc = getDoctor(did); if (!state.special) state.special = {}; if (!state.special[did]) state.special[did] = {};
    let h = `<div class="sh-step-section">`;
    h += `<div class="sh-subtitle" style="margin-top:0;">👨‍⚕️ ${doc.name} <span style="font-size:10px;color:#999;font-weight:400;">#${doc.number}</span></div>`;
    h += `<div class="sh-btn-group"><button class="sh-btn-action sh-btn-xs sh-btn-outline" data-action="toggleAllSpecial" data-on="true" data-doc="${did}">全选</button><button class="sh-btn-action sh-btn-xs sh-btn-outline" data-action="toggleAllSpecial" data-on="false" data-doc="${did}">取消全选</button><button class="sh-btn-action sh-btn-xs sh-btn-outline" data-action="toggleWorkdaySpecial" data-doc="${did}">工作日全选</button><button class="sh-btn-action sh-btn-xs sh-btn-outline" data-action="toggleSlotSpecial" data-doc="${did}" data-slot="am">上午全选</button><button class="sh-btn-action sh-btn-xs sh-btn-outline" data-action="toggleSlotSpecial" data-doc="${did}" data-slot="pm">下午全选</button></div>`;
    h += `<div class="sh-form-row" style="margin:8px 0;"><select id="sh-batch-special-type" style="flex:1;font-size:10px;"><option value="">选择批量应用的类型</option>${A.SPECIAL_TYPES.map(t=>`<option value="${t}">${t}</option>`).join('')}</select><button class="sh-btn-action sh-btn-primary sh-btn-sm" data-action="batchSpecial" data-doc="${did}">应用</button><button class="sh-btn-action sh-btn-danger sh-btn-sm" data-action="batchClearSpecial" data-doc="${did}">清除选中</button></div>`;
    for (let d = 0; d < 7; d++) { const sp = (state.special[did] || {})[d] || { am: null, pm: null }; const bg = A.isHoliday(state.workdayConfig, d) ? '#fffbe6' : '#fafafa'; h += `<div style="margin-bottom:3px;padding:5px 8px;background:${bg};border-radius:4px;font-size:10px;display:flex;align-items:center;gap:4px;"><strong style="min-width:30px;">${A.DAYS[d]}</strong>`;
      for (let sl of A.SLOTS) h += `<label style="display:flex;align-items:center;gap:2px;flex:1;font-size:9px;cursor:pointer;"><input type="checkbox" class="sh-special-chk" data-doc="${did}" data-day="${d}" data-slot="${sl}">${A.SLOT_LABELS[sl]}<select data-action="updateSpecial" data-doc="${did}" data-day="${d}" data-slot="${sl}" style="flex:1;font-size:10px;"><option value="">—</option>${A.SPECIAL_TYPES.map(t=>`<option value="${t}" ${sp[sl]===t?'selected':''}>${t}</option>`).join('')}</select></label>`;
      h += `<span style="font-size:8px;color:#999;min-width:44px;text-align:right;">${sp.am||'—'} / ${sp.pm||'—'}</span></div>`; }
    h += `</div>`;
    fd.innerHTML = h;
  }

  // ===== S4: 值班 =====
  function renderS4(body) {
    if (!state.dutyOrder || state.dutyOrder.length !== 8) state.dutyOrder = A.buildDefaultDutyOrder(state.doctors);
    const order = state.dutyOrder || [], pool = A.getDutyDoctorPool(state.doctors), flags = state.baiban1Flags || [];
    let h = `<div class="sh-info-bar info">💡· 按住 ⋮⋮ 拖拽调整顺序。<br>· 节假日的中班自动转为休假。<br>· 已有安排不会被覆盖，安排后与门诊等冲突时，相应格子会闪烁提示。<br>· 重新执行自动排班，请先点清空按钮。</div>`;
    h += `<div class="sh-subtitle">📋 值班序列 <span style="font-size:10px;color:#999;font-weight:400;">(${order.filter(id=>id&&getDoctor(id)).length}/8)</span></div>`;
    h += `<div id="sh-duty-order">`;
    for (let i = 0; i < 8; i++) { const did = order[i] || '', doc = getDoctor(did); h += `<div class="sh-duty-row" draggable="true" data-action="dutyDrag" data-idx="${i}"><span class="sh-drag-handle">⋮⋮</span><select data-action="updateDutyOrder" data-idx="${i}" style="flex:1;max-width:110px;font-size:10px;"><option value="">— 空 —</option>${pool.map(d=>`<option value="${d.id}" ${did===d.id?'selected':''}>${d.name}</option>`).join('')}</select><span class="sh-duty-desc">${A.getDutyRowDesc(state.workdayConfig, i)}</span></div>`; }
    h += `</div>`;
    h += `<div class="sh-btn-group" style="margin-top:8px;"><button class="sh-btn-action sh-btn-outline sh-btn-sm" data-action="resetDutyOrder">🔄 重置默认顺序</button><label style="font-size:10px;display:flex;align-items:center;gap:4px;margin-left:auto;cursor:pointer;"><input type="checkbox" id="sh-cancel-zb"> 假期前一天取消中班</label></div>`;
    h += `<button class="sh-btn-action sh-btn-primary sh-btn-block" data-action="runAutoDuty" style="margin-top:6px;">🤖 执行自动排班</button>`;
    h += `<button class="sh-btn-action sh-btn-danger sh-btn-block" data-action="clearDuty">🗑 清空值班安排</button>`;
    if (flags.length) h += `<div class="sh-info-bar warn" style="margin-top:8px;">⚠️ 检测到 <b>${flags.length}</b> 个安排冲突，请前往下一步处理。</div>`;
    else h += `<div class="sh-info-bar success" style="margin-top:8px;">✅ 无冲突</div>`;
    h += `<div class="sh-nav-row"><button class="sh-btn-action sh-btn-outline" data-action="goToStep" data-step="3">← 上一步</button><button class="sh-btn-action sh-btn-primary" data-action="goToStep" data-step="5">下一步 → 调整确认</button></div>`;
    body.innerHTML = h;
    const cb = document.getElementById('sh-cancel-zb'); if (cb) { cb.checked = state.cancelPreHolidayZhongban; cb.addEventListener('change', function () { state.cancelPreHolidayZhongban = this.checked; }); }
  }

  // ===== S5: 确认 =====
  function renderS5(body) {
    const flags = state.baiban1Flags || [], trainees = state.doctors.filter(d => d.type === 'trainee');
    let h = `<div class="sh-info-bar info">💡 点击下方"分配白1"按钮，可快速安排白班1！</div>`;

    // ===== （一）调整冲突 =====
    h += `<div class="sh-subtitle" style="font-size:13px;color:#333;">（一）调整冲突</div>`;
    if (flags.length) {
      h += `<div class="sh-info-bar warn">⚠️ ${flags.length}个冲突可能需要安排白班1</div><ul class="sh-conflict-list">`;
      for (let f of flags) {
        const resolved = !!f.resolvedBy;
        h += `<li class="${resolved ? 'resolved' : ''}" style="${resolved ? 'background:#f5f5f5;border-color:#d9d9d9;text-decoration:none;opacity:1;' : ''}"><span>${resolved ? 'ℹ️' : '⚠️'}</span><span style="flex:1;font-size:10px;">${f.reason}</span><span style="font-size:9px;color:#999;">${A.DAYS[f.dayIdx]}${A.SLOT_LABELS[f.slot]}</span>${resolved ? '' : `<button class="sh-btn-action sh-btn-primary sh-btn-xs" data-action="quickBaiban1" data-day="${f.dayIdx}" data-slot="${f.slot}">分配白1</button>`}</li>`;
      }
      h += `</ul>`;
    } else {
      h += `<div class="sh-info-bar success">✅ 所有冲突已解决！</div>`;
    }

    // ===== （二）周末值班补休 =====
    h += `<div class="sh-divider"></div><div class="sh-subtitle" style="font-size:13px;color:#333;">（二）周末值班补休</div>`;
    const wkDutyDocs = A.getWeekendDutyDoctors(state);
    if (wkDutyDocs.length > 0) {
      const names = wkDutyDocs.map(d => d.name).join('、');
      h += `<div class="sh-info-bar info" style="font-size:10px;">${names} 节假日参与值班，请在本周工作日为其分别找一个人员充足的下午安排休假。</div>`;
    } else {
      h += `<div class="sh-help-text">本周无人在节假日值班，无需安排补休。</div>`;
    }

    // ===== （三）一键填补空缺 =====
    h += `<div class="sh-divider"></div><div class="sh-subtitle" style="font-size:13px;color:#333;">（三）一键填补空缺</div>`;
    h += `<div class="sh-help-text">依据设定的工作日/节假日：<br>工作日→<b style="color:#2196f3;">白班普</b> · 节假日→<b style="color:#999;">休假</b></div>`;
    h += `<button class="sh-btn-action sh-btn-primary sh-btn-block" data-action="fillEmpty" style="margin-bottom:8px;">🪣 一键填空（白班普/休）</button>`;

    // ===== （四）规培生一键安排 =====
    if (trainees.length) {
      h += `<div class="sh-divider"></div><div class="sh-subtitle" style="font-size:13px;color:#333;">（四）规培生一键安排</div>`;
      h += `<div class="sh-help-text">为 ${trainees.map(d => d.name).join('、')} 应用对应导师的排班（已设定的安排不会被覆盖）。</div>`;
      h += `<button class="sh-btn-action sh-btn-success sh-btn-block" data-action="syncTrainees">🔄 为规培生应用导师排班</button>`;
    }

    // ===== 流程结束 =====
    h += `<div class="sh-divider"></div><div class="sh-subtitle" style="font-size:14px;color:#333;">✅ 排班流程结束！</div>`;

    // 统计
    const stats = A.computeWeekStats(state);
    h += `<div class="sh-divider"></div><div class="sh-subtitle">📊 本周统计</div>`;
    h += `<div class="sh-stats-wrap">${Object.entries(stats).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span class="sh-stat-tag" style="background:${A.TYPE_COLORS[k]}18;border-color:${A.TYPE_COLORS[k]}44;color:${A.TYPE_COLORS[k]};">${k}: ${v}次</span>`).join('') || '<span style="font-size:10px;color:#999;">暂无数据</span>'}</div>`;

    // 导出 / 导入 / 提交
    h += `<div class="sh-btn-group" style="margin-top:10px;">`;
    h += `<button class="sh-btn-action sh-btn-primary sh-btn-sm" data-action="exportFull">📤 导出完整配置</button>`;
    h += `<button class="sh-btn-action sh-btn-outline sh-btn-sm" data-action="importFull">📥 导入完整配置</button>`;
    h += `</div>`;
    h += `<button class="sh-btn-action sh-btn-primary sh-btn-block" data-action="submitAll" style="margin-top:8px;">✅ 提交所有修改到系统</button>`;
    h += `<div class="sh-nav-row"><button class="sh-btn-action sh-btn-outline" data-action="goToStep" data-step="4">← 上一步</button></div>`;
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
        console.log('[排班辅助] ⚡ fiber切换成功:', fiberResult.year, '年 第', fiberResult.week, '周');
        return fiberResult;
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
    var mondayDate = new Date(result.monday);
    var year = mondayDate.getFullYear();
    console.log('[排班辅助] DOM切换:', year, '年 第', result.week, '周, 周一:', result.monday);
    return { year: year, week: result.week, monday: result.monday };
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

    // 清除门诊预览
    prevWeekOutpatientPreview = null;
    prevWeekOutpatientLoaded = false;

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
    const pms = pm.toISOString().slice(0, 10);
    const pme = getSunday(pms);

    showToast('正在加载上周门诊数据...', 'info');
    console.log('[排班辅助] 拉取上周(', pms, '~', pme, ')门诊数据...');

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
        d2i[dt.toISOString().slice(0, 10)] = d;
      }

      // 初始化预览结构
      const previewGeneral = {}; // {dayIdx: {am: [doctorIds], pm: [doctorIds]}}
      const previewGaoxin = [];
      const previewZitong = [];
      const conflicts = []; // {dayIdx, slot, doctorIds:[]}
      for (let d = 0; d < 7; d++) previewGeneral[d] = { am: [], pm: [] };

      let totalParsed = 0;

      for (let r of scheds) {
        const eid = String(r.empId || r.employeeId || '');
        const wd = (r.workDate || r.date || '').slice(0, 10);
        const cn = classIdMap[String(r.id || r.classId || r.scheduleClassId || '')] || r.name || r.className || '';
        const di = d2i[wd];
        if (di === undefined || !eid || !cn) continue;

        // 仅检查当前周存在的医生
        const docExists = state.doctors.some(d => d.id === eid);
        if (!docExists) continue;

        const sl = r.segment ? (r.segment === 1 ? 'am' : 'pm') : (r.slot || r.ampm || r.timeSlot || 'am');

        if (cn === '总院门诊') {
          if (!previewGeneral[di]) previewGeneral[di] = { am: [], pm: [] };
          if (!previewGeneral[di][sl].includes(eid)) {
            previewGeneral[di][sl].push(eid);
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
    let appliedGeneral = 0, appliedGaoxin = 0, appliedZitong = 0, skippedConflict = 0;

    // 找出冲突的时段集合
    const conflictSet = new Set();
    for (let c of preview.conflicts) {
      conflictSet.add(`${c.dayIdx}_${c.slot}`);
    }

    // 应用总院门诊（跳过冲突时段）
    for (let d = 0; d < 7; d++) {
      for (let sl of ['am', 'pm']) {
        const key = `${d}_${sl}`;
        if (conflictSet.has(key)) {
          skippedConflict++;
          continue;
        }
        const arr = (preview.outpatientGeneral[d] && preview.outpatientGeneral[d][sl]) ? preview.outpatientGeneral[d][sl] : [];
        if (arr.length === 0) continue;
        // 取第一个作为总院门诊，其余的如果有则跳过（冲突已在前面处理）
        const eid = arr[0];
        if (!state.outpatientGeneral[d]) state.outpatientGeneral[d] = { am: null, pm: null };
        if (!state.outpatientGeneral[d][sl]) {
          state.outpatientGeneral[d][sl] = eid;
          appliedGeneral++;
        }
        // 如果该时段有多个，第2个设为简易门诊候选（提醒用户）
        if (arr.length >= 2) {
          const eid2 = arr[1];
          // 检查是否已经存在简易门诊
          const existsSimple = (state.outpatientSimple || []).some(
            a => a.dayIdx === d && a.slot === sl && a.doctorId === eid2
          );
          if (!existsSimple) {
            if (!state.outpatientSimple) state.outpatientSimple = [];
            state.outpatientSimple.push({ dayIdx: d, slot: sl, doctorId: eid2 });
          }
        }
      }
    }

    // 应用高新门诊
    for (let ga of preview.outpatientGaoxin) {
      const exists = (state.outpatientGaoxin || []).some(
        a => a.dayIdx === ga.dayIdx && a.doctorId === ga.doctorId
      );
      if (!exists) {
        if (!state.outpatientGaoxin) state.outpatientGaoxin = [];
        state.outpatientGaoxin.push({ dayIdx: ga.dayIdx, doctorId: ga.doctorId });
        appliedGaoxin++;
      }
    }

    // 应用梓潼门诊
    for (let zt of preview.outpatientZitong) {
      const exists = (state.outpatientZitong || []).some(
        a => a.dayIdx === zt.dayIdx && a.doctorId === zt.doctorId
      );
      if (!exists) {
        if (!state.outpatientZitong) state.outpatientZitong = [];
        state.outpatientZitong.push({ dayIdx: zt.dayIdx, doctorId: zt.doctorId });
        appliedZitong++;
      }
    }

    syncStateToBackground();
    renderPanel();

    let msg = `已应用：总院门诊×${appliedGeneral} 高新门诊×${appliedGaoxin} 梓潼门诊×${appliedZitong}`;
    if (skippedConflict > 0) msg += `\n⚠️ ${skippedConflict} 个冲突时段已跳过，请手动处理`;
    if (preview.conflicts.length > 0) {
      msg += '\n💡 多个总院门诊的时段已自动将第2位设为简易门诊，请检查确认。';
    }
    showToast(msg, preview.conflicts.length > 0 ? 'warn' : 'success');
  }

  /** 清除上周门诊预览 */
  function clearPrevWeekPreview() {
    prevWeekOutpatientPreview = null;
    prevWeekOutpatientLoaded = false;
    renderPanel();
    showToast('已清除上周门诊预览', 'info');
  }

  // ==================== 业务操作函数 ====================
  function toggleWorkday(d) { if (!state.workdayConfig) state.workdayConfig = [true,true,true,true,true,false,false]; state.workdayConfig[d] = !state.workdayConfig[d]; renderPanel(); syncStateToBackground(); }
  function updateMentor(traineeId, mentorId) {
    const doc = getDoctor(traineeId);
    if (!doc) return;
    doc.mentorId = mentorId || null;
    syncStateToBackground();
    renderPanel();
  }
  function updateGeneral(di, sl, did) { if (!state.outpatientGeneral[di]) state.outpatientGeneral[di] = { am: null, pm: null }; state.outpatientGeneral[di][sl] = did || null; syncStateToBackground(); }
  function addGaoxin() { if (!state.outpatientGaoxin) state.outpatientGaoxin = []; state.outpatientGaoxin.push({ dayIdx: null, doctorId: null }); renderPanel(); }
  function updateGaoxin(i, f, v) { if (!state.outpatientGaoxin) state.outpatientGaoxin = []; if (!state.outpatientGaoxin[i]) state.outpatientGaoxin[i] = { dayIdx: null, doctorId: null }; state.outpatientGaoxin[i][f] = (v || v === 0) ? v : null; syncStateToBackground(); }
  function removeGaoxin(i) { state.outpatientGaoxin.splice(i, 1); renderPanel(); }
  function addZitong() { if (!state.outpatientZitong) state.outpatientZitong = []; state.outpatientZitong.push({ dayIdx: null, doctorId: null }); renderPanel(); }
  function updateZitong(i, f, v) { if (!state.outpatientZitong) state.outpatientZitong = []; if (!state.outpatientZitong[i]) state.outpatientZitong[i] = { dayIdx: null, doctorId: null }; state.outpatientZitong[i][f] = (v || v === 0) ? v : null; syncStateToBackground(); }
  function removeZitong(i) { state.outpatientZitong.splice(i, 1); renderPanel(); }
  function addSimple() { if (!state.outpatientSimple) state.outpatientSimple = []; state.outpatientSimple.push({ dayIdx: null, doctorId: null, slot: null }); renderPanel(); }
  function updateSimple(i, f, v) { if (!state.outpatientSimple) state.outpatientSimple = []; if (!state.outpatientSimple[i]) state.outpatientSimple[i] = { dayIdx: null, doctorId: null, slot: null }; state.outpatientSimple[i][f] = (v || v === 0) ? v : null; syncStateToBackground(); }
  function removeSimple(i) { state.outpatientSimple.splice(i, 1); renderPanel(); }

  function clearOutpatient() {
    if (!confirm('清空所有门诊安排？')) return;
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
      reader.onload = function (ev) {
        try {
          const data = JSON.parse(ev.target.result);
          if (data.type !== 'outpatient' || !data.version) { showToast('无效的门诊配置文件', 'error'); return; }
          if (!confirm('导入门诊安排？当前数据将被替换。')) return;
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
  function updateSpecial(did, di, sl, t) { if (!state.special) state.special = {}; if (!state.special[did]) state.special[did] = {}; if (!state.special[did][di]) state.special[did][di] = { am: null, pm: null }; state.special[did][di][sl] = t || null; syncStateToBackground(); }
  function toggleAllSpecial(on, did) { document.querySelectorAll(`.sh-special-chk[data-doc="${did}"]`).forEach(cb => cb.checked = on); }
  function toggleWorkdaySpecial(did) { document.querySelectorAll(`.sh-special-chk[data-doc="${did}"]`).forEach(cb => { cb.checked = (state.workdayConfig || [])[+cb.dataset.day]; }); }
  function toggleSlotSpecial(did, slot) { document.querySelectorAll(`.sh-special-chk[data-doc="${did}"][data-slot="${slot}"]`).forEach(cb => { cb.checked = true; }); }
  function batchSpecial(did) { const t = document.getElementById('sh-batch-special-type')?.value; if (!t) { showToast('请选择类型', 'warn'); return; } const chk = [...document.querySelectorAll(`.sh-special-chk[data-doc="${did}"]:checked`)]; if (!chk.length) { showToast('请勾选时段', 'warn'); return; } if (!state.special) state.special = {}; if (!state.special[did]) state.special[did] = {}; chk.forEach(cb => { const di = +cb.dataset.day, sl = cb.dataset.slot; if (!state.special[did][di]) state.special[did][di] = { am: null, pm: null }; state.special[did][di][sl] = t; }); renderSpecialDocForm(); syncStateToBackground(); showToast(`已应用 ${t} ×${chk.length}`, 'success'); }
  function batchClearSpecial(did) { const chk = [...document.querySelectorAll(`.sh-special-chk[data-doc="${did}"]:checked`)]; if (!chk.length) { showToast('请勾选时段', 'warn'); return; } if (!state.special) state.special = {}; if (!state.special[did]) state.special[did] = {}; chk.forEach(cb => { const di = +cb.dataset.day, sl = cb.dataset.slot; if (!state.special[did][di]) state.special[did][di] = { am: null, pm: null }; state.special[did][di][sl] = null; }); renderSpecialDocForm(); showToast(`已清除 ×${chk.length}`, 'success'); }
  function updateDutyOrder(i, did) { if (!state.dutyOrder) state.dutyOrder = []; while (state.dutyOrder.length < 8) state.dutyOrder.push(''); state.dutyOrder[i] = did || ''; renderPanel(); syncStateToBackground(); }
  function resetDutyOrder() { state.dutyOrder = A.buildDefaultDutyOrder(state.doctors); renderPanel(); }
  function runAutoDuty() { const f = (state.dutyOrder || []).filter(id => id && getDoctor(id)).length; if (!f) { showToast('请先设置值班序列', 'warn'); return; } if (!confirm('执行自动排班？已有安排不会被覆盖。')) return; const r = A.computeAutoDuty(state); state.dutyAssigned = r.dutyAssigned; state.baiban1Flags = r.baiban1Flags; renderPanel(); syncStateToBackground(); const c = state.baiban1Flags.filter(fl => fl.isConflict).length; showToast(c ? `排班完成！${c}个冲突需处理` : '排班完成，无冲突！', c ? 'warn' : 'success'); }
  function clearDuty() { if (!confirm('清空所有值班安排？')) return; state.dutyAssigned = {}; state.baiban1Flags = []; renderPanel(); }
  function quickBaiban1(di, sl) { const cand = A.getBaiban1Candidates(state, di, sl); if (!cand.length) { showToast('无可用医生', 'warn'); return; } const names = cand.map((d, i) => `${i + 1}. ${d.name}(#${d.number})`).join('\n'); const choice = prompt(`选择白班1医生（${A.DAYS[di]}${A.SLOT_LABELS[sl]}）:\n\n${names}\n\n输入序号:`); if (!choice) return; const idx = +choice - 1; if (idx < 0 || idx >= cand.length) { showToast('无效选择', 'error'); return; } const doc = cand[idx]; if (!state.dutyAssigned) state.dutyAssigned = {}; if (!state.dutyAssigned[doc.id]) state.dutyAssigned[doc.id] = {}; if (!state.dutyAssigned[doc.id][di]) state.dutyAssigned[doc.id][di] = { am: null, pm: null }; state.dutyAssigned[doc.id][di][sl] = '白班1'; state.baiban1Flags = A.resolveConflict(state.baiban1Flags, di, sl, doc.id, doc.name); renderPanel(); syncStateToBackground(); }
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
      reader.onload = function (ev) {
        try {
          const data = JSON.parse(ev.target.result);
          if (data.type !== 'fullSchedule' || !data.version) { showToast('无效的排班配置文件', 'error'); return; }
          if (!confirm('导入完整排班表？当前所有排班数据将被替换。')) return;
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
