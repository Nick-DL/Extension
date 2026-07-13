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
  let dragSrcIdx = null;

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
    }).catch(err => { console.error('[排班辅助] 数据加载失败:', err); showToast('数据加载失败', 'error'); });
  }

  function onDisabled() {
    togglePanel(false); document.getElementById('sh-quick-entry').classList.add('hidden');
    if (restoreFetch) { restoreFetch(); restoreFetch = null; }
    removeClassColorBars(); showToast('排班辅助插件已关闭', 'info');
  }

  // ==================== 周信息检测 ====================
  function detectWeekInfo() {
    const urlParams = new URLSearchParams(window.location.search);
    const dp = urlParams.get('date') || urlParams.get('from') || urlParams.get('startDate');
    if (dp) { weekInfo = getWeekInfo(new Date(dp)); return; }
    const els = document.querySelectorAll('[class*="date"], [class*="week"], [class*="picker"]');
    for (let el of els) {
      const m = (el.textContent || '').match(/(\d{4})[年\-\/](\d{1,2})[月\-\/](\d{1,2})/);
      if (m) { weekInfo = getWeekInfo(new Date(+m[1], +m[2] - 1, +m[3])); return; }
    }
    if (!weekInfo.monday) weekInfo = getWeekInfo(new Date());
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
      const cr = await ScheduleAPI.fetchClasses();
      if (!cr.error && cr.data) {
        const cls = Array.isArray(cr.data) ? cr.data : (cr.data.rows || cr.data.list || []);
        classMap = {}; classIdMap = {};
        cls.forEach(c => { const n = c.className || c.name || ''; const id = c.id || c.classId || ''; if (n && id) { classMap[n] = String(id); classIdMap[String(id)] = n; } });
      }
      const lr = await ScheduleAPI.fetchLocations();
      if (!lr.error && lr.data) { const locs = Array.isArray(lr.data) ? lr.data : (lr.data.rows || lr.data.list || []); if (locs.length) locationId = String(locs[0].id || locs[0].locationId || ''); }
      const er = await ScheduleAPI.fetchEmployees({ from: weekInfo.monday, to: getSunday(weekInfo.monday) });
      if (!er.error && er.data) { const emps = Array.isArray(er.data) ? er.data : (er.data.rows || er.data.list || []); state.doctors = ScheduleAPI.buildDoctorsFromAPI(emps); }
      if (state.doctors.length) {
        const sr = await ScheduleAPI.fetchEmpSchedules({ empIds: state.doctors.map(d => d.id), from: weekInfo.monday, to: getSunday(weekInfo.monday) });
        if (!sr.error && sr.data) parseSchedulesFromAPI(sr.data);
      }
      await loadPrevWeekData();
      if (!state.dutyOrder || state.dutyOrder.length !== 8) state.dutyOrder = A.buildDefaultDutyOrder(state.doctors);
    } catch (err) { console.error('[排班辅助] 数据刷新异常:', err); }
  }

  function parseSchedulesFromAPI(data) {
    const scheds = Array.isArray(data) ? data : (data.rows || data.list || []);
    state.outpatientGeneral = {}; state.dutyAssigned = {}; state.special = {};
    for (let d = 0; d < 7; d++) state.outpatientGeneral[d] = { am: null, pm: null };
    const m = new Date(weekInfo.monday); const d2i = {};
    for (let d = 0; d < 7; d++) { const dt = new Date(m); dt.setDate(m.getDate() + d); d2i[dt.toISOString().slice(0, 10)] = d; }
    for (let r of scheds) {
      const eid = String(r.empId || r.employeeId || ''), wd = r.workDate || r.date || '';
      const cn = classIdMap[String(r.classId || r.scheduleClassId || '')] || r.className || '';
      const di = d2i[wd]; if (di === undefined || !eid || !cn) continue;
      const sl = r.slot || r.ampm || r.timeSlot || 'am';
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
  }

  async function loadPrevWeekData() {
    try { const resp = await chrome.runtime.sendMessage({ type: 'GET_PREV_WEEK_DATA' }); if (resp.success && resp.data) { applyPrevWeekData(resp.data); return; } } catch (e) { /* ignore */ }
    const pm = new Date(weekInfo.monday); pm.setDate(pm.getDate() - 7); const pms = pm.toISOString().slice(0, 10);
    try {
      const eids = state.doctors.map(d => d.id); if (!eids.length) return;
      const sr = await ScheduleAPI.fetchEmpSchedules({ empIds: eids, from: pms, to: getSunday(pms) });
      if (!sr.error && sr.data) chrome.runtime.sendMessage({ type: 'SAVE_PREV_WEEK_DATA', data: { monday: pms, schedules: sr.data } });
    } catch (e) { /* ignore */ }
  }
  function applyPrevWeekData(prevData) { console.log('[排班辅助] 已加载上周数据作为预置'); }

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

  // ==================== 事件代理：一条规则解决所有 CSP 问题 ====================
  function setupPanelDelegation(panel) {
    const body = panel.querySelector('#sh-panel-body');

    // click 代理
    body.addEventListener('click', (e) => {
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
        case 'renderSpecialForm': renderSpecialDocForm(); break;
        case 'toggleAllSpecial': toggleAllSpecial(ds.on === 'true', ds.doc); break;
        case 'toggleWorkdaySpecial': toggleWorkdaySpecial(ds.doc); break;
        case 'batchSpecial': batchSpecial(ds.doc); break;
        case 'batchClearSpecial': batchClearSpecial(ds.doc); break;
        case 'resetDutyOrder': resetDutyOrder(); break;
        case 'runAutoDuty': runAutoDuty(); break;
        case 'clearDuty': clearDuty(); break;
        case 'quickBaiban1': quickBaiban1(+ds.day, ds.slot); break;
        case 'fillEmpty': fillEmpty(); break;
        case 'syncTrainees': syncTrainees(); break;
        case 'submitAll': submitAllChanges(); break;
      }
    });

    // change 代理 (select元素)
    body.addEventListener('change', (e) => {
      const el = e.target.closest('[data-action]'); if (!el) return;
      const action = el.dataset.action; const ds = el.dataset; const val = el.value;
      switch (action) {
        case 'updateGeneral': updateGeneral(+ds.day, ds.slot, val); break;
        case 'updateGaoxin': updateGaoxin(+ds.idx, ds.field, ds.field === 'dayIdx' ? +val : val); break;
        case 'updateZitong': updateZitong(+ds.idx, ds.field, ds.field === 'dayIdx' ? +val : val); break;
        case 'updateSimple': updateSimple(+ds.idx, ds.field, ds.field === 'dayIdx' ? +val : val); break;
        case 'updateSpecial': updateSpecial(ds.doc, +ds.day, ds.slot, val); break;
        case 'updateDutyOrder': updateDutyOrder(+ds.idx, val); break;
        case 'renderSpecialForm': renderSpecialDocForm(); break;
      }
    });

    // 拖拽代理
    body.addEventListener('dragstart', (e) => {
      const el = e.target.closest('[data-action="dutyDrag"]'); if (!el) return;
      dragSrcIdx = +el.dataset.idx;
    });

    body.addEventListener('dragover', (e) => { e.preventDefault(); });

    body.addEventListener('drop', (e) => {
      e.preventDefault();
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
    const docs = state.doctors; let h = `<div class="sh-info-bar info">💡 人员数据从系统自动加载。仅显示"医疗"和"规培"类别。</div><div style="font-weight:600;font-size:12px;margin-bottom:4px;">📋 人员列表 (${docs.length}人)</div><ul class="sh-doc-list">`;
    for (let d of docs) { const tc = d.type === 'trainee' ? '规培' : d.type === 'director' ? '主任' : '医生'; let ex = ''; if (d.type === 'trainee') { const m = getDoctor(d.mentorId); ex = `导师:${m ? m.name : '—'}`; } if (d.training) ex = '培训中'; if (d.onLeave) ex = '休假中'; h += `<li><span><strong>#${d.number}</strong> ${d.name} <span style="font-size:10px;color:#999;">${tc}</span><span style="font-size:9px;color:#bbb;">${ex}</span></span></li>`; }
    h += `</ul><div class="sh-divider"></div><div style="font-weight:600;font-size:12px;margin-bottom:4px;">📅 工作日/节假日设定</div><div class="sh-btn-group">`;
    for (let d = 0; d < 7; d++) { const wd = (state.workdayConfig || [])[d]; h += `<button class="sh-btn-action sh-btn-sm ${wd ? 'sh-btn-primary' : 'sh-btn-outline'}" data-action="toggleWorkday" data-day="${d}" style="flex:1;">${A.DAYS[d]}</button>`; }
    h += `</div><button class="sh-btn-action sh-btn-primary sh-btn-block" data-action="goToStep" data-step="2" style="margin-top:10px;">下一步 → 门诊安排</button>`;
    body.innerHTML = h;
  }

  // ===== S2: 门诊 =====
  function renderS2(body) {
    let h = `<div class="sh-info-bar info">💡 门诊分为四类管理。门诊具有最高优先级。</div>`;
    h += `<div style="font-weight:600;font-size:12px;margin:8px 0 4px;color:#3f51b5;">🏥 总院门诊</div>`;
    for (let d = 0; d < 7; d++) { const gen = state.outpatientGeneral[d] || { am: null, pm: null }; h += `<div style="margin-bottom:3px;font-size:11px;"><strong>${A.DAYS[d]}</strong><div class="sh-form-row">`;
      for (let s of A.SLOTS) h += `<div style="flex:1;"><span style="font-size:10px;color:#999;">${A.SLOT_LABELS[s]}</span><select data-action="updateGeneral" data-day="${d}" data-slot="${s}" style="font-size:10px;"><option value="">—</option>${docOptsHtmlSelected(gen[s])}</select></div>`; h += `</div></div>`; }
    h += `<div style="font-weight:600;font-size:12px;margin:8px 0 4px;color:#009688;">🏥 高新门诊（仅上午）</div><div id="sh-gaoxin-rows">`;
    (state.outpatientGaoxin || []).forEach((it, i) => { h += renderGxRow(i, it); });
    h += `</div><button class="sh-btn-action sh-btn-outline sh-btn-sm sh-btn-block" data-action="addGaoxin">➕ 添加</button>`;
    h += `<div style="font-weight:600;font-size:12px;margin:8px 0 4px;color:#00bcd4;">🏥 梓潼门诊（仅上午·每两周周三）</div><div id="sh-zitong-rows">`;
    (state.outpatientZitong || []).forEach((it, i) => { h += renderZtRow(i, it); });
    h += `</div><button class="sh-btn-action sh-btn-outline sh-btn-sm sh-btn-block" data-action="addZitong">➕ 添加</button>`;
    h += `<div style="font-weight:600;font-size:12px;margin:8px 0 4px;color:#3f51b5;">🏥 简易门诊</div><div id="sh-simple-rows">`;
    (state.outpatientSimple || []).forEach((it, i) => { h += renderSmRow(i, it); });
    h += `</div><button class="sh-btn-action sh-btn-outline sh-btn-sm sh-btn-block" data-action="addSimple">➕ 添加</button>`;
    h += `<div class="sh-btn-group" style="margin-top:10px;"><button class="sh-btn-action sh-btn-outline" data-action="goToStep" data-step="1">← 上一步</button><button class="sh-btn-action sh-btn-primary" data-action="goToStep" data-step="3" style="margin-left:auto;">下一步 →</button></div>`;
    body.innerHTML = h;
  }
  function renderGxRow(i, it) { it = it || {}; return `<div class="sh-form-row" style="align-items:center;margin-bottom:2px;"><select data-action="updateGaoxin" data-idx="${i}" data-field="dayIdx" style="flex:1;font-size:10px;"><option value="">选择日期</option>${[0,1,2,3,4].map(d=>`<option value="${d}" ${it.dayIdx===d?'selected':''}>${A.DAYS[d]}</option>`).join('')}</select><select data-action="updateGaoxin" data-idx="${i}" data-field="doctorId" style="flex:1;font-size:10px;"><option value="">选择医生</option>${docOptsHtmlSelected(it.doctorId||'')}</select><button class="sh-btn-action sh-btn-danger sh-btn-xs" data-action="removeGaoxin" data-idx="${i}">✕</button></div>`; }
  function renderZtRow(i, it) { it = it || {}; return `<div class="sh-form-row" style="align-items:center;margin-bottom:2px;"><select data-action="updateZitong" data-idx="${i}" data-field="dayIdx" style="flex:1;font-size:10px;"><option value="">选择日期</option>${[0,1,2,3,4].map(d=>`<option value="${d}" ${it.dayIdx===d?'selected':''}>${A.DAYS[d]}</option>`).join('')}</select><select data-action="updateZitong" data-idx="${i}" data-field="doctorId" style="flex:1;font-size:10px;"><option value="">选择医生</option>${docOptsHtmlSelected(it.doctorId||'')}</select><button class="sh-btn-action sh-btn-danger sh-btn-xs" data-action="removeZitong" data-idx="${i}">✕</button></div>`; }
  function renderSmRow(i, it) { it = it || {}; return `<div class="sh-form-row" style="align-items:center;margin-bottom:2px;"><select data-action="updateSimple" data-idx="${i}" data-field="dayIdx" style="flex:1;font-size:10px;"><option value="">日期</option>${[0,1,2,3,4,5,6].map(d=>`<option value="${d}" ${it.dayIdx===d?'selected':''}>${A.DAYS[d]}</option>`).join('')}</select><select data-action="updateSimple" data-idx="${i}" data-field="slot" style="flex:0.7;font-size:10px;"><option value="">时段</option><option value="am" ${it.slot==='am'?'selected':''}>上午</option><option value="pm" ${it.slot==='pm'?'selected':''}>下午</option></select><select data-action="updateSimple" data-idx="${i}" data-field="doctorId" style="flex:1;font-size:10px;"><option value="">医生</option>${docOptsHtmlSelected(it.doctorId||'')}</select><button class="sh-btn-action sh-btn-danger sh-btn-xs" data-action="removeSimple" data-idx="${i}">✕</button></div>`; }

  // ===== S3: 特殊安排 =====
  function renderS3(body) {
    let h = `<div class="sh-info-bar info">💡 为每位医生设置特殊安排（产假/事假/休/二线/培训/开会/医疗保障）。</div><label>选择医生</label><select id="sh-special-doc" data-action="renderSpecialForm"><option value="">— 请选择 —</option>${state.doctors.map(d=>`<option value="${d.id}">${d.name} (#${d.number})</option>`).join('')}</select><div id="sh-special-form" style="margin-top:6px;"></div><div class="sh-btn-group" style="margin-top:10px;"><button class="sh-btn-action sh-btn-outline" data-action="goToStep" data-step="2">← 上一步</button><button class="sh-btn-action sh-btn-primary" data-action="goToStep" data-step="4" style="margin-left:auto;">下一步 →</button></div>`;
    body.innerHTML = h;
  }
  function renderSpecialDocForm() {
    const sel = document.getElementById('sh-special-doc'), fd = document.getElementById('sh-special-form'); if (!sel || !fd) return;
    const did = sel.value; if (!did) { fd.innerHTML = ''; return; }
    const doc = getDoctor(did); if (!state.special) state.special = {}; if (!state.special[did]) state.special[did] = {};
    let h = `<div style="font-weight:600;font-size:12px;margin-bottom:2px;">${doc.name}</div><div class="sh-btn-group"><button class="sh-btn-action sh-btn-xs sh-btn-outline" data-action="toggleAllSpecial" data-on="true" data-doc="${did}">全选</button><button class="sh-btn-action sh-btn-xs sh-btn-outline" data-action="toggleAllSpecial" data-on="false" data-doc="${did}">取消</button><button class="sh-btn-action sh-btn-xs sh-btn-outline" data-action="toggleWorkdaySpecial" data-doc="${did}">工作日</button></div><div class="sh-form-row" style="margin:6px 0;"><select id="sh-batch-special-type" style="flex:1;font-size:10px;"><option value="">选择类型</option>${A.SPECIAL_TYPES.map(t=>`<option value="${t}">${t}</option>`).join('')}</select><button class="sh-btn-action sh-btn-primary sh-btn-sm" data-action="batchSpecial" data-doc="${did}">应用</button><button class="sh-btn-action sh-btn-danger sh-btn-sm" data-action="batchClearSpecial" data-doc="${did}">清除</button></div>`;
    for (let d = 0; d < 7; d++) { const sp = (state.special[did] || {})[d] || { am: null, pm: null }; const bg = A.isHoliday(state.workdayConfig, d) ? '#fffbe6' : '#fafafa'; h += `<div style="margin-bottom:2px;padding:3px 6px;background:${bg};border-radius:4px;font-size:10px;display:flex;align-items:center;gap:4px;"><strong style="min-width:28px;">${A.DAYS[d]}</strong>`;
      for (let sl of A.SLOTS) h += `<label style="display:flex;align-items:center;gap:2px;flex:1;font-size:9px;"><input type="checkbox" class="sh-special-chk" data-doc="${did}" data-day="${d}" data-slot="${sl}">${A.SLOT_LABELS[sl]}<select data-action="updateSpecial" data-doc="${did}" data-day="${d}" data-slot="${sl}" style="flex:1;font-size:10px;"><option value="">—</option>${A.SPECIAL_TYPES.map(t=>`<option value="${t}" ${sp[sl]===t?'selected':''}>${t}</option>`).join('')}</select></label>`;
      h += `<span style="font-size:8px;color:#999;min-width:40px;text-align:right;">${sp.am||'—'}/${sp.pm||'—'}</span></div>`; }
    fd.innerHTML = h;
  }

  // ===== S4: 值班 =====
  function renderS4(body) {
    if (!state.dutyOrder || state.dutyOrder.length !== 8) state.dutyOrder = A.buildDefaultDutyOrder(state.doctors);
    const order = state.dutyOrder || [], pool = A.getDutyDoctorPool(state.doctors), flags = state.baiban1Flags || [];
    let h = `<div class="sh-info-bar info">💡· 拖拽排序值班医生。· 节假日中班自动转休。</div><div style="font-weight:600;font-size:12px;">📋 值班序列 (${order.filter(id=>id&&getDoctor(id)).length}/8)</div><div id="sh-duty-order">`;
    for (let i = 0; i < 8; i++) { const did = order[i] || '', doc = getDoctor(did); h += `<div class="sh-duty-row" draggable="true" data-action="dutyDrag" data-idx="${i}"><span class="sh-drag-handle">⋮⋮</span><select data-action="updateDutyOrder" data-idx="${i}" style="flex:1;max-width:110px;font-size:10px;"><option value="">— 空 —</option>${pool.map(d=>`<option value="${d.id}" ${did===d.id?'selected':''}>${d.name}</option>`).join('')}</select><span class="sh-duty-desc">${A.getDutyRowDesc(state.workdayConfig, i)}</span></div>`; }
    h += `</div><div class="sh-btn-group" style="margin-top:6px;"><button class="sh-btn-action sh-btn-outline sh-btn-sm" data-action="resetDutyOrder">🔄 默认顺序</button><label style="font-size:10px;display:flex;align-items:center;gap:4px;margin-left:auto;"><input type="checkbox" id="sh-cancel-zb"> 假前一天取消中班</label></div><button class="sh-btn-action sh-btn-primary sh-btn-block" data-action="runAutoDuty">🤖 执行自动排班</button><button class="sh-btn-action sh-btn-danger sh-btn-block" data-action="clearDuty">🗑 清空值班</button>`;
    if (flags.length) h += `<div class="sh-info-bar warn" style="margin-top:6px;">⚠️ ${flags.length}个冲突需处理</div>`;
    h += `<div class="sh-btn-group" style="margin-top:10px;"><button class="sh-btn-action sh-btn-outline" data-action="goToStep" data-step="3">← 上一步</button><button class="sh-btn-action sh-btn-primary" data-action="goToStep" data-step="5" style="margin-left:auto;">下一步 →</button></div>`;
    body.innerHTML = h;
    const cb = document.getElementById('sh-cancel-zb'); if (cb) { cb.checked = state.cancelPreHolidayZhongban; cb.addEventListener('change', function () { state.cancelPreHolidayZhongban = this.checked; }); }
  }

  // ===== S5: 确认 =====
  function renderS5(body) {
    const flags = state.baiban1Flags || [], trainees = state.doctors.filter(d => d.type === 'trainee');
    let h = `<div class="sh-info-bar info">💡 处理冲突、规培生同步，最后提交。</div><div style="font-weight:600;font-size:12px;">（一）冲突处理</div>`;
    if (flags.length) { h += `<ul class="sh-conflict-list">`;
      for (let f of flags) { const r = !!f.resolvedBy; h += `<li class="${r?'resolved':''}"><span>${r?'ℹ️':'⚠️'}</span><span style="flex:1;">${f.reason}</span><span style="font-size:9px;">${A.DAYS[f.dayIdx]}${A.SLOT_LABELS[f.slot]}</span>${r?'':`<button class="sh-btn-action sh-btn-primary sh-btn-xs" data-action="quickBaiban1" data-day="${f.dayIdx}" data-slot="${f.slot}">分配白1</button>`}</li>`; }
      h += `</ul>`; } else { h += `<div class="sh-info-bar success">✅ 无冲突</div>`; }
    h += `<div style="font-weight:600;font-size:12px;margin-top:8px;">（二）一键填空</div><button class="sh-btn-action sh-btn-primary sh-btn-block" data-action="fillEmpty">🪣 空白→白班普/休</button>`;
    if (trainees.length) h += `<div style="font-weight:600;font-size:12px;margin-top:8px;">（三）规培生同步</div><button class="sh-btn-action sh-btn-success sh-btn-block" data-action="syncTrainees">🔄 ${trainees.map(d=>d.name).join('、')} 应用导师排班</button>`;
    const stats = A.computeWeekStats(state);
    h += `<div style="font-weight:600;font-size:12px;margin-top:8px;">📊 统计</div><div style="font-size:10px;">${Object.entries(stats).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`<span style="display:inline-block;margin:2px;padding:1px 6px;background:${A.TYPE_COLORS[k]}22;border-radius:8px;border:1px solid ${A.TYPE_COLORS[k]}44;">${k}:${v}次</span>`).join('')||'暂无'}</div>`;
    h += `<div class="sh-divider"></div><button class="sh-btn-action sh-btn-primary sh-btn-block" data-action="submitAll">✅ 提交所有修改</button><div class="sh-btn-group" style="margin-top:6px;"><button class="sh-btn-action sh-btn-outline" data-action="goToStep" data-step="4">← 上一步</button></div>`;
    body.innerHTML = h;
  }

  // ==================== 业务操作函数 ====================
  function toggleWorkday(d) { if (!state.workdayConfig) state.workdayConfig = [true,true,true,true,true,false,false]; state.workdayConfig[d] = !state.workdayConfig[d]; renderPanel(); syncStateToBackground(); }
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
  function updateSpecial(did, di, sl, t) { if (!state.special) state.special = {}; if (!state.special[did]) state.special[did] = {}; if (!state.special[did][di]) state.special[did][di] = { am: null, pm: null }; state.special[did][di][sl] = t || null; syncStateToBackground(); }
  function toggleAllSpecial(on, did) { document.querySelectorAll(`.sh-special-chk[data-doc="${did}"]`).forEach(cb => cb.checked = on); }
  function toggleWorkdaySpecial(did) { document.querySelectorAll(`.sh-special-chk[data-doc="${did}"]`).forEach(cb => { cb.checked = (state.workdayConfig || [])[+cb.dataset.day]; }); }
  function batchSpecial(did) { const t = document.getElementById('sh-batch-special-type')?.value; if (!t) { showToast('请选择类型', 'warn'); return; } const chk = [...document.querySelectorAll(`.sh-special-chk[data-doc="${did}"]:checked`)]; if (!chk.length) { showToast('请勾选时段', 'warn'); return; } if (!state.special) state.special = {}; if (!state.special[did]) state.special[did] = {}; chk.forEach(cb => { const di = +cb.dataset.day, sl = cb.dataset.slot; if (!state.special[did][di]) state.special[did][di] = { am: null, pm: null }; state.special[did][di][sl] = t; }); renderSpecialDocForm(); syncStateToBackground(); showToast(`已应用 ${t} ×${chk.length}`, 'success'); }
  function batchClearSpecial(did) { const chk = [...document.querySelectorAll(`.sh-special-chk[data-doc="${did}"]:checked`)]; if (!chk.length) { showToast('请勾选时段', 'warn'); return; } if (!state.special) state.special = {}; if (!state.special[did]) state.special[did] = {}; chk.forEach(cb => { const di = +cb.dataset.day, sl = cb.dataset.slot; if (!state.special[did][di]) state.special[did][di] = { am: null, pm: null }; state.special[did][di][sl] = null; }); renderSpecialDocForm(); showToast(`已清除 ×${chk.length}`, 'success'); }
  function updateDutyOrder(i, did) { if (!state.dutyOrder) state.dutyOrder = []; while (state.dutyOrder.length < 8) state.dutyOrder.push(''); state.dutyOrder[i] = did || ''; renderPanel(); syncStateToBackground(); }
  function resetDutyOrder() { state.dutyOrder = A.buildDefaultDutyOrder(state.doctors); renderPanel(); }
  function runAutoDuty() { const f = (state.dutyOrder || []).filter(id => id && getDoctor(id)).length; if (!f) { showToast('请先设置值班序列', 'warn'); return; } if (!confirm('执行自动排班？已有安排不会被覆盖。')) return; const r = A.computeAutoDuty(state); state.dutyAssigned = r.dutyAssigned; state.baiban1Flags = r.baiban1Flags; renderPanel(); syncStateToBackground(); const c = state.baiban1Flags.filter(fl => fl.isConflict).length; showToast(c ? `排班完成！${c}个冲突需处理` : '排班完成，无冲突！', c ? 'warn' : 'success'); }
  function clearDuty() { if (!confirm('清空所有值班安排？')) return; state.dutyAssigned = {}; state.baiban1Flags = []; renderPanel(); }
  function quickBaiban1(di, sl) { const cand = A.getBaiban1Candidates(state, di, sl); if (!cand.length) { showToast('无可用医生', 'warn'); return; } const names = cand.map((d, i) => `${i + 1}. ${d.name}(#${d.number})`).join('\n'); const choice = prompt(`选择白班1医生（${A.DAYS[di]}${A.SLOT_LABELS[sl]}）:\n\n${names}\n\n输入序号:`); if (!choice) return; const idx = +choice - 1; if (idx < 0 || idx >= cand.length) { showToast('无效选择', 'error'); return; } const doc = cand[idx]; if (!state.dutyAssigned) state.dutyAssigned = {}; if (!state.dutyAssigned[doc.id]) state.dutyAssigned[doc.id] = {}; if (!state.dutyAssigned[doc.id][di]) state.dutyAssigned[doc.id][di] = { am: null, pm: null }; state.dutyAssigned[doc.id][di][sl] = '白班1'; state.baiban1Flags = A.resolveConflict(state.baiban1Flags, di, sl, doc.id, doc.name); renderPanel(); syncStateToBackground(); }
  function fillEmpty() { const r = A.computeFillEmpty(state); state.dutyAssigned = r.dutyAssigned; renderPanel(); syncStateToBackground(); showToast(`已填补 ${r.count} 个空缺`, 'success'); }
  function syncTrainees() { const r = A.computeTraineeSync(state); state.dutyAssigned = r.dutyAssigned; state.traineeFlags = r.traineeFlags; renderPanel(); syncStateToBackground(); showToast('规培生已同步导师排班', 'success'); }

  // ==================== 启动 ====================
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  console.log('[排班辅助] Content Script 已加载 (CSP-safe, 事件代理模式)');
})();
