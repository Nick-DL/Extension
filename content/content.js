/**
 * Content Script - 排班辅助插件主逻辑
 * 注入到排班系统页面中运行
 */

(function () {
  'use strict';

  // ==================== 全局状态（与示例网页保持一致） ====================
  const A = ScheduleAlgorithm;

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

  let extEnabled = false;
  let panelVisible = false;
  let isMinimized = false;
  let restoreFetch = null;
  let classMap = {};        // 班型名称 → classId
  let classIdMap = {};      // classId → 班型名称
  let locationId = '';
  let originalData = null;
  let weekInfo = { year: new Date().getFullYear(), week: 1, monday: '' };

  // ==================== 初始化 ====================
  function init() {
    // 初始化数据结构
    for (let d = 0; d < 7; d++) state.outpatientGeneral[d] = { am: null, pm: null };

    // 注入UI
    injectPanel();
    injectQuickEntry();
    injectToastContainer();

    // 监听消息
    chrome.runtime.onMessage.addListener(handleMessage);

    // 检测是否已启用
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (resp) => {
      if (resp && resp.success) {
        extEnabled = resp.data.enabled;
        if (extEnabled) {
          onEnabled();
        }
      }
    });
  }

  // ==================== 消息处理 ====================
  function handleMessage(message, sender, sendResponse) {
    switch (message.type) {
      case 'TOGGLE_ENABLED':
        extEnabled = message.enabled;
        if (extEnabled) onEnabled();
        else onDisabled();
        sendResponse({ success: true });
        break;

      case 'OPEN_PANEL':
        if (!extEnabled) {
          showToast('请先在扩展弹窗中启用辅助插件', 'warn');
        } else {
          togglePanel(true);
        }
        sendResponse({ success: true });
        break;

      case 'REFRESH_DATA':
        refreshAllData().then(() => {
          showToast('数据已刷新', 'success');
          renderPanel();
        });
        sendResponse({ success: true });
        break;

      case 'RESTORE_DATA':
        restoreOriginalData();
        sendResponse({ success: true });
        break;

      default:
        sendResponse({ success: true });
    }
    return true;
  }

  // ==================== 启用/禁用 ====================
  function onEnabled() {
    showToast('排班辅助插件已启用', 'success');
    document.getElementById('sh-quick-entry').classList.remove('hidden');

    // 拦截API
    restoreFetch = ScheduleAPI.interceptScheduleAPI();

    // 监听主页面API拦截通知
    window.addEventListener('scheduling-api-blocked', (e) => {
      showToast('主页面排班修改已被拦截，请通过辅助面板操作', 'warn');
    });

    // 尝试读取页面数据
    detectWeekInfo();
    refreshAllData().then(() => {
      // 备份原始数据
      originalData = JSON.parse(JSON.stringify({
        doctors: state.doctors,
        outpatientGeneral: state.outpatientGeneral,
        outpatientSimple: state.outpatientSimple,
        outpatientGaoxin: state.outpatientGaoxin,
        outpatientZitong: state.outpatientZitong,
        special: state.special,
        dutyAssigned: state.dutyAssigned,
        workdayConfig: state.workdayConfig
      }));

      chrome.runtime.sendMessage({
        type: 'UPDATE_ORIGINAL_DATA',
        data: originalData
      });

      // 同步状态到background
      syncStateToBackground();

      // 更新popup信息
      chrome.runtime.sendMessage({
        type: 'UPDATE_WEEK_INFO',
        weekInfo: weekInfo
      });

      // 打开浮窗
      togglePanel(true);
    }).catch(err => {
      console.error('[排班辅助] 数据加载失败:', err);
      showToast('数据加载失败，请检查网络或登录状态', 'error');
    });
  }

  function onDisabled() {
    togglePanel(false);
    document.getElementById('sh-quick-entry').classList.add('hidden');

    // 恢复API拦截
    if (restoreFetch) {
      restoreFetch();
      restoreFetch = null;
    }

    // 移除班级色条
    removeClassColorBars();

    showToast('排班辅助插件已关闭', 'info');
  }

  // ==================== 页面信息检测 ====================
  function detectWeekInfo() {
    // 尝试从页面URL、DOM元素或breadcrumb中检测当前工作周
    const urlParams = new URLSearchParams(window.location.search);
    const dateParam = urlParams.get('date') || urlParams.get('from') || urlParams.get('startDate');

    if (dateParam) {
      const d = new Date(dateParam);
      weekInfo = getWeekInfo(d);
    } else {
      // 尝试从页面元素读取
      const dateEls = document.querySelectorAll('[class*="date"], [class*="week"], [class*="picker"]');
      for (let el of dateEls) {
        const text = el.textContent || '';
        const match = text.match(/(\d{4})[年\-\/](\d{1,2})[月\-\/](\d{1,2})/);
        if (match) {
          const d = new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]));
          weekInfo = getWeekInfo(d);
          break;
        }
      }
      // 兜底：使用本周
      if (!weekInfo.monday) {
        weekInfo = getWeekInfo(new Date());
      }
    }

    console.log('[排班辅助] 检测到工作周:', weekInfo);
  }

  function getWeekInfo(date) {
    const d = new Date(date);
    const dayOfWeek = d.getDay(); // 0=周日
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(d);
    monday.setDate(d.getDate() + mondayOffset);

    // 计算ISO周序
    const yearStart = new Date(monday.getFullYear(), 0, 1);
    const weekNum = Math.ceil(((monday - yearStart) / 86400000 + yearStart.getDay() + 1) / 7);

    return {
      year: monday.getFullYear(),
      week: weekNum,
      monday: monday.toISOString().slice(0, 10)
    };
  }

  // ==================== 数据加载 ====================
  async function refreshAllData() {
    try {
      // 1. 加载班型列表
      const classResp = await ScheduleAPI.fetchClasses();
      if (!classResp.error && classResp.data) {
        const classes = Array.isArray(classResp.data) ? classResp.data :
                       (classResp.data.rows || classResp.data.list || []);
        classMap = {};
        classIdMap = {};
        classes.forEach(c => {
          const name = c.className || c.name || c['班型名称'] || '';
          const id = c.id || c.classId || c['班型ID'] || '';
          if (name && id) {
            classMap[name] = String(id);
            classIdMap[String(id)] = name;
          }
        });
        console.log('[排班辅助] 加载班型:', Object.keys(classMap).length, '种');
      }

      // 2. 加载院区
      const locResp = await ScheduleAPI.fetchLocations();
      if (!locResp.error && locResp.data) {
        const locs = Array.isArray(locResp.data) ? locResp.data :
                     (locResp.data.rows || locResp.data.list || []);
        if (locs.length > 0) {
          locationId = String(locs[0].id || locs[0].locationId || '');
        }
      }

      // 3. 加载员工列表
      const empResp = await ScheduleAPI.fetchEmployees({
        from: weekInfo.monday,
        to: getSunday(weekInfo.monday)
      });
      if (!empResp.error && empResp.data) {
        const emps = Array.isArray(empResp.data) ? empResp.data :
                     (empResp.data.rows || empResp.data.list || []);
        state.doctors = ScheduleAPI.buildDoctorsFromAPI(emps);
        console.log('[排班辅助] 加载员工:', state.doctors.length, '人');
      }

      // 4. 加载排班数据
      if (state.doctors.length > 0) {
        const empIds = state.doctors.map(d => d.id);
        const schedResp = await ScheduleAPI.fetchEmpSchedules({
          empIds: empIds,
          from: weekInfo.monday,
          to: getSunday(weekInfo.monday)
        });

        if (!schedResp.error && schedResp.data) {
          parseSchedulesFromAPI(schedResp.data);
        }
      }

      // 5. 尝试加载上周数据作为预置
      await loadPrevWeekData();

      // 6. 初始化值班顺序
      if (!state.dutyOrder || state.dutyOrder.length !== 8) {
        state.dutyOrder = A.buildDefaultDutyOrder(state.doctors);
      }

    } catch (err) {
      console.error('[排班辅助] 数据刷新异常:', err);
    }
  }

  function getSunday(mondayStr) {
    const d = new Date(mondayStr);
    d.setDate(d.getDate() + 6);
    return d.toISOString().slice(0, 10);
  }

  /**
   * 将API返回的排班数据解析为内部state格式
   */
  function parseSchedulesFromAPI(data) {
    const schedules = Array.isArray(data) ? data : (data.rows || data.list || []);

    // 重置
    state.outpatientGeneral = {};
    state.dutyAssigned = {};
    state.special = {};
    for (let d = 0; d < 7; d++) state.outpatientGeneral[d] = { am: null, pm: null };

    // 构建日期→dayIdx映射
    const monday = new Date(weekInfo.monday);
    const dateToDayIdx = {};
    for (let d = 0; d < 7; d++) {
      const dt = new Date(monday);
      dt.setDate(monday.getDate() + d);
      dateToDayIdx[dt.toISOString().slice(0, 10)] = d;
    }

    for (let record of schedules) {
      const empId = String(record.empId || record.employeeId || '');
      const workDate = record.workDate || record.date || '';
      const classId = String(record.classId || record.scheduleClassId || '');
      const className = classIdMap[classId] || record.className || '';

      const dayIdx = dateToDayIdx[workDate];
      if (dayIdx === undefined || !empId || !className) continue;

      // 判断时间段（通常排班数据中包含am/pm信息）
      const slot = record.slot || record.ampm || record.timeSlot || 'am'; // 默认上午

      // 判断安排类型
      if (A.CLINIC_TYPES.includes(className)) {
        // 门诊
        if (className === '总院门诊') {
          if (!state.outpatientGeneral[dayIdx]) state.outpatientGeneral[dayIdx] = { am: null, pm: null };
          state.outpatientGeneral[dayIdx][slot] = empId;
        } else if (className === '高新门诊') {
          if (!state.outpatientGaoxin.find(a => a.dayIdx === dayIdx && a.doctorId === empId)) {
            state.outpatientGaoxin.push({ dayIdx, doctorId: empId });
          }
        } else if (className === '梓潼门诊') {
          if (!state.outpatientZitong.find(a => a.dayIdx === dayIdx && a.doctorId === empId)) {
            state.outpatientZitong.push({ dayIdx, doctorId: empId });
          }
        }
      } else if (A.SPECIAL_TYPES.includes(className)) {
        if (!state.special[empId]) state.special[empId] = {};
        if (!state.special[empId][dayIdx]) state.special[empId][dayIdx] = { am: null, pm: null };
        state.special[empId][dayIdx][slot] = className;
      } else {
        // 值班/白班等
        if (!state.dutyAssigned[empId]) state.dutyAssigned[empId] = {};
        if (!state.dutyAssigned[empId][dayIdx]) state.dutyAssigned[empId][dayIdx] = { am: null, pm: null };
        state.dutyAssigned[empId][dayIdx][slot] = className;
      }
    }
  }

  /**
   * 加载上周数据作为预置（门诊+值班）
   */
  async function loadPrevWeekData() {
    // 先从storage读取缓存
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'GET_PREV_WEEK_DATA' });
      if (resp.success && resp.data) {
        applyPrevWeekData(resp.data);
        return;
      }
    } catch (e) { /* 忽略 */ }

    // 尝试从API加载
    const prevMonday = new Date(weekInfo.monday);
    prevMonday.setDate(prevMonday.getDate() - 7);
    const prevMondayStr = prevMonday.toISOString().slice(0, 10);
    const prevSundayStr = getSunday(prevMondayStr);

    try {
      const empIds = state.doctors.map(d => d.id);
      if (empIds.length === 0) return;

      const schedResp = await ScheduleAPI.fetchEmpSchedules({
        empIds, from: prevMondayStr, to: prevSundayStr
      });

      if (!schedResp.error && schedResp.data) {
        // 缓存上周数据
        chrome.runtime.sendMessage({
          type: 'SAVE_PREV_WEEK_DATA',
          data: {
            monday: prevMondayStr,
            schedules: schedResp.data
          }
        });
      }
    } catch (e) {
      console.log('[排班辅助] 无法加载上周数据:', e.message);
    }
  }

  function applyPrevWeekData(prevData) {
    // 将上周的门诊和值班数据映射为本周预置
    // 门诊完全复制，值班按顺序轮转
    // TODO: 具体映射逻辑需根据API实际返回格式调整
    console.log('[排班辅助] 已加载上周数据作为预置');
  }

  // ==================== 恢复原始数据 ====================
  function restoreOriginalData() {
    if (!originalData) {
      showToast('没有可恢复的备份数据', 'warn');
      return;
    }
    if (!confirm('确定恢复为操作前的原始数据？')) return;

    state.doctors = JSON.parse(JSON.stringify(originalData.doctors || []));
    state.outpatientGeneral = JSON.parse(JSON.stringify(originalData.outpatientGeneral || {}));
    state.outpatientSimple = JSON.parse(JSON.stringify(originalData.outpatientSimple || []));
    state.outpatientGaoxin = JSON.parse(JSON.stringify(originalData.outpatientGaoxin || []));
    state.outpatientZitong = JSON.parse(JSON.stringify(originalData.outpatientZitong || []));
    state.special = JSON.parse(JSON.stringify(originalData.special || {}));
    state.dutyAssigned = JSON.parse(JSON.stringify(originalData.dutyAssigned || {}));
    state.workdayConfig = JSON.parse(JSON.stringify(originalData.workdayConfig || [true, true, true, true, true, false, false]));
    state.baiban1Flags = [];
    state.dutyOrder = A.buildDefaultDutyOrder(state.doctors);

    applyToPageTable();
    renderPanel();
    showToast('已恢复原始数据', 'success');
  }

  // ==================== 同步状态到 Background ====================
  function syncStateToBackground() {
    chrome.runtime.sendMessage({
      type: 'UPDATE_SCHEDULE_STATE',
      scheduleState: {
        doctors: state.doctors,
        workdayConfig: state.workdayConfig,
        outpatientGeneral: state.outpatientGeneral,
        outpatientSimple: state.outpatientSimple,
        outpatientGaoxin: state.outpatientGaoxin,
        outpatientZitong: state.outpatientZitong,
        special: state.special,
        dutyAssigned: state.dutyAssigned,
        dutyOrder: state.dutyOrder
      }
    });
    chrome.runtime.sendMessage({
      type: 'UPDATE_CLASS_MAP',
      classMap: classMap
    });
    chrome.runtime.sendMessage({
      type: 'UPDATE_LOCATION',
      locationId: locationId
    });
  }

  // ==================== 应用到页面表格 ====================
  /**
   * 将扩展内部的排班数据渲染到页面表格中
   * 通过修改班级色条（小横条）颜色来反映班型
   */
  function applyToPageTable() {
    // 策略：找到页面中的排班表格单元格，给每个添加色条
    const monday = new Date(weekInfo.monday);
    const dates = [];
    for (let d = 0; d < 7; d++) {
      const dt = new Date(monday);
      dt.setDate(monday.getDate() + d);
      dates.push(dt.toISOString().slice(0, 10));
    }

    // 构建 employeeId → dayIdx → {am, pm} 的映射
    const empScheduleMap = {};
    for (let doc of state.doctors) {
      empScheduleMap[doc.id] = {};
      for (let d = 0; d < 7; d++) {
        empScheduleMap[doc.id][d] = {
          am: A.getSlotSchedule(state, doc.id, d, 'am'),
          pm: A.getSlotSchedule(state, doc.id, d, 'pm')
        };
      }
    }

    // 查找页面中的排班单元格并添加色条
    const cells = document.querySelectorAll('.ant-table-cell, td[class*="schedule"], td[class*="cell"]');
    cells.forEach(cell => {
      // 尝试从data属性或内容中匹配员工和日期
      const cellText = cell.textContent || '';
      // 这里需要根据实际页面DOM结构调整
      applyClassColorBar(cell, null);
    });
  }

  /**
   * 给页面表格中的排班格子下方添加班型标识色条
   */
  function applyClassColorBar(cellElement, scheduleType) {
    // 移除旧色条
    const oldBar = cellElement.querySelector('.sh-class-color-bar');
    if (oldBar) oldBar.remove();

    if (!scheduleType) return;

    const color = A.TYPE_COLORS[scheduleType];
    if (!color) return;

    cellElement.style.position = cellElement.style.position || 'relative';
    const bar = document.createElement('div');
    bar.className = 'sh-class-color-bar';
    bar.style.background = color;
    cellElement.appendChild(bar);
  }

  function removeClassColorBars() {
    document.querySelectorAll('.sh-class-color-bar').forEach(bar => bar.remove());
  }

  // ==================== 提交修改 ====================
  async function submitAllChanges() {
    if (!confirm('确定提交所有排班修改？\n提交成功后请刷新页面查看。')) return;

    try {
      // 构建批量修改数据
      const batchData = ScheduleAPI.buildBatchData(state, classMap, locationId, weekInfo.monday);

      if (batchData.length === 0) {
        showToast('没有需要提交的修改', 'warn');
        return;
      }

      // 先清除本周所有现有排班（可选，取决于业务逻辑）
      // 再批量设置新排班
      const resp = await ScheduleAPI.appendUsualClass(batchData);
      if (resp.error) {
        showToast('提交失败: ' + (resp.message || '未知错误'), 'error');
        return;
      }

      showToast(`成功提交 ${batchData.length} 条排班记录！请刷新页面查看。`, 'success');

      // 取消API拦截
      if (restoreFetch) {
        restoreFetch();
        restoreFetch = null;
      }
      chrome.runtime.sendMessage({ type: 'SET_INTERCEPTING', intercepting: false });

      // 延迟提示刷新
      setTimeout(() => {
        if (confirm('排班已提交成功，是否刷新页面？')) {
          window.location.reload();
        }
      }, 1500);

    } catch (err) {
      console.error('[排班辅助] 提交失败:', err);
      showToast('提交异常: ' + err.message, 'error');
    }
  }

  // ==================== 辅助函数 ====================
  function getDoctor(id) { return A.getDoctor(state.doctors, id); }

  // ==================== UI渲染将在 floating-panel-render.js 中定义 ====================
  // 为了代码组织清晰，面板渲染逻辑独立
  // 此处的函数是桥梁

  // ==================== Toast ====================
  function showToast(msg, type) {
    const container = document.getElementById('sh-toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `sh-toast ${type}`;
    toast.textContent = msg;
    toast.onclick = () => toast.remove();
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  // ==================== DOM 注入 ====================
  function injectQuickEntry() {
    if (document.getElementById('sh-quick-entry')) return;
    const entry = document.createElement('div');
    entry.id = 'sh-quick-entry';
    entry.className = 'hidden';
    entry.textContent = '排班辅助';
    entry.title = '点击打开排班辅助面板';
    entry.onclick = () => togglePanel(true);
    document.body.appendChild(entry);
  }

  function injectToastContainer() {
    if (document.getElementById('sh-toast-container')) return;
    const container = document.createElement('div');
    container.id = 'sh-toast-container';
    container.className = 'sh-toast-container';
    document.body.appendChild(container);
  }

  function injectPanel() {
    if (document.getElementById('scheduling-helper-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'scheduling-helper-panel';
    panel.innerHTML = `
      <div class="sh-panel-header" id="sh-panel-header">
        <span class="sh-title">🏥 排班辅助</span>
        <div class="sh-actions">
          <button class="sh-btn" id="sh-btn-minimize" title="最小化">−</button>
          <button class="sh-btn" id="sh-btn-close" title="关闭">✕</button>
        </div>
      </div>
      <div class="sh-steps-bar" id="sh-steps-bar">
        <div class="sh-step-item active" data-step="1"><span class="sh-step-num">1</span>人员</div>
        <div class="sh-step-item" data-step="2"><span class="sh-step-num">2</span>门诊</div>
        <div class="sh-step-item" data-step="3"><span class="sh-step-num">3</span>特殊</div>
        <div class="sh-step-item" data-step="4"><span class="sh-step-num">4</span>值班</div>
        <div class="sh-step-item" data-step="5"><span class="sh-step-num">5</span>确认</div>
      </div>
      <div class="sh-panel-body" id="sh-panel-body"></div>
    `;
    document.body.appendChild(panel);

    // 拖拽功能
    makeDraggable(panel.querySelector('.sh-panel-header'), panel);

    // 按钮事件
    document.getElementById('sh-btn-minimize').onclick = () => toggleMinimize();
    document.getElementById('sh-btn-close').onclick = () => togglePanel(false);

    // 步骤切换
    document.querySelectorAll('#sh-steps-bar .sh-step-item').forEach(item => {
      item.onclick = () => goToStep(parseInt(item.dataset.step));
    });
  }

  function makeDraggable(handle, target) {
    let isDragging = false, startX, startY, startLeft, startTop;

    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = target.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      target.style.transition = 'none';
      document.body.style.userSelect = 'none';

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    function onMouseMove(e) {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      target.style.left = (startLeft + dx) + 'px';
      target.style.top = (startTop + dy) + 'px';
      target.style.right = 'auto';
    }

    function onMouseUp() {
      isDragging = false;
      target.style.transition = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    }
  }

  // ==================== 面板控制 ====================
  function togglePanel(show) {
    const panel = document.getElementById('scheduling-helper-panel');
    if (!panel) return;
    panelVisible = show;
    if (show) {
      panel.classList.add('visible');
      if (isMinimized) toggleMinimize(); // 恢复展开
      goToStep(state.currentStep);
    } else {
      panel.classList.remove('visible');
    }
  }

  function toggleMinimize() {
    const panel = document.getElementById('scheduling-helper-panel');
    const body = document.getElementById('sh-panel-body');
    const steps = document.getElementById('sh-steps-bar');
    if (!panel) return;

    isMinimized = !isMinimized;
    if (isMinimized) {
      panel.classList.add('minimized');
      body.style.display = 'none';
      steps.style.display = 'none';
    } else {
      panel.classList.remove('minimized');
      body.style.display = '';
      steps.style.display = '';
    }
  }

  // ==================== 步骤导航 ====================
  function goToStep(n) {
    state.currentStep = n;
    renderStepsBar();
    renderPanel();
  }

  function renderStepsBar() {
    document.querySelectorAll('#sh-steps-bar .sh-step-item').forEach(item => {
      const s = parseInt(item.dataset.step);
      item.classList.remove('active', 'done');
      if (s === state.currentStep) item.classList.add('active');
      else if (s < state.currentStep) item.classList.add('done');
    });
  }

  // ==================== 面板内容渲染（委托到独立函数） ====================
  function renderPanel() {
    const body = document.getElementById('sh-panel-body');
    if (!body) return;

    switch (state.currentStep) {
      case 1: renderStep1_Personnel(body); break;
      case 2: renderStep2_Outpatient(body); break;
      case 3: renderStep3_Special(body); break;
      case 4: renderStep4_Duty(body); break;
      case 5: renderStep5_Confirm(body); break;
    }
  }

  // ===== 步骤1：人员设定（只读，从API加载） =====
  function renderStep1_Personnel(body) {
    const docs = state.doctors;
    let html = `<div class="sh-info-bar info">💡 人员数据从系统自动加载。仅显示"医疗"和"规培"类别。</div>`;
    html += `<div style="font-weight:600;font-size:12px;margin-bottom:4px;">📋 人员列表 (${docs.length}人)</div>`;
    html += `<ul class="sh-doc-list">`;

    for (let doc of docs) {
      const tc = doc.type === 'trainee' ? '规培' : doc.type === 'director' ? '主任' : '医生';
      let ex = '';
      if (doc.type === 'trainee') {
        const m = getDoctor(doc.mentorId);
        ex = `导师:${m ? m.name : '—'}`;
      }
      if (doc.training) ex = '培训中';
      if (doc.onLeave) ex = '休假中';
      html += `<li>
        <span><strong>#${doc.number}</strong> ${doc.name} <span style="font-size:10px;color:#999;">${tc}</span>
        <span style="font-size:9px;color:#bbb;">${ex}</span></span>
      </li>`;
    }
    html += `</ul>`;

    // 工作日配置
    html += `<div class="sh-divider"></div>`;
    html += `<div style="font-weight:600;font-size:12px;margin-bottom:4px;">📅 工作日/节假日设定</div>`;
    html += `<div class="sh-btn-group">`;
    for (let d = 0; d < 7; d++) {
      const isWorkday = (state.workdayConfig || [])[d];
      html += `<button class="sh-btn-action sh-btn-sm ${isWorkday ? 'sh-btn-primary' : 'sh-btn-outline'}"
        onclick="window._shToggleWorkday(${d})" style="flex:1;">${A.DAYS[d]}</button>`;
    }
    html += `</div>`;

    html += `<button class="sh-btn-action sh-btn-primary sh-btn-block" onclick="window._shGoToStep(2)" style="margin-top:10px;">
      下一步 → 门诊安排</button>`;

    body.innerHTML = html;
  }

  // ===== 步骤2：门诊安排 =====
  function renderStep2_Outpatient(body) {
    const docOpts = state.doctors
      .filter(dc => dc.type !== 'trainee')
      .map(dc => `<option value="${dc.id}">${dc.name}</option>`).join('');

    let html = `<div class="sh-info-bar info">💡 门诊分为四类管理。门诊具有最高优先级。<br>· 总院门诊 每天上/下午<br>· 简易门诊 时间不固定<br>· 高新门诊 周内上午<br>· 梓潼门诊 周三上午</div>`;

    // 总院门诊
    html += `<div style="font-weight:600;font-size:12px;margin:8px 0 4px;color:#3f51b5;">🏥 总院门诊</div>`;
    for (let d = 0; d < 7; d++) {
      const gen = state.outpatientGeneral[d] || { am: null, pm: null };
      html += `<div style="margin-bottom:3px;font-size:11px;">
        <strong>${A.DAYS[d]}</strong>
        <div class="sh-form-row">`;
      for (let s of A.SLOTS) {
        html += `<div style="flex:1;">
          <span style="font-size:10px;color:#999;">${A.SLOT_LABELS[s]}</span>
          <select onchange="window._shUpdateGeneral(${d},'${s}',this.value)" style="font-size:10px;">
            <option value="">—</option>
            ${state.doctors.filter(dc=>dc.type!=='trainee').map(dc=>`<option value="${dc.id}" ${gen[s]===dc.id?'selected':''}>${dc.name}</option>`).join('')}
          </select></div>`;
      }
      html += `</div></div>`;
    }

    // 高新门诊
    html += `<div style="font-weight:600;font-size:12px;margin:8px 0 4px;color:#009688;">🏥 高新门诊（仅上午）</div>`;
    html += `<div id="sh-gaoxin-rows">`;
    const gx = state.outpatientGaoxin || [];
    for (let i = 0; i < gx.length; i++) {
      html += renderGaoxinRow(i, gx[i]);
    }
    html += `</div>`;
    html += `<button class="sh-btn-action sh-btn-outline sh-btn-sm sh-btn-block" onclick="window._shAddGaoxin()">➕ 添加</button>`;

    // 梓潼门诊
    html += `<div style="font-weight:600;font-size:12px;margin:8px 0 4px;color:#00bcd4;">🏥 梓潼门诊（仅上午·每两周周三）</div>`;
    html += `<div id="sh-zitong-rows">`;
    const zt = state.outpatientZitong || [];
    for (let i = 0; i < zt.length; i++) {
      html += renderZitongRow(i, zt[i]);
    }
    html += `</div>`;
    html += `<button class="sh-btn-action sh-btn-outline sh-btn-sm sh-btn-block" onclick="window._shAddZitong()">➕ 添加</button>`;

    // 简易门诊
    html += `<div style="font-weight:600;font-size:12px;margin:8px 0 4px;color:#3f51b5;">🏥 简易门诊</div>`;
    html += `<div id="sh-simple-rows">`;
    const sim = state.outpatientSimple || [];
    for (let i = 0; i < sim.length; i++) {
      html += renderSimpleRow(i, sim[i]);
    }
    html += `</div>`;
    html += `<button class="sh-btn-action sh-btn-outline sh-btn-sm sh-btn-block" onclick="window._shAddSimple()">➕ 添加</button>`;

    html += `<div class="sh-btn-group" style="margin-top:10px;">
      <button class="sh-btn-action sh-btn-outline" onclick="window._shGoToStep(1)">← 上一步</button>
      <button class="sh-btn-action sh-btn-primary" onclick="window._shGoToStep(3)" style="margin-left:auto;">下一步 →</button>
    </div>`;
    body.innerHTML = html;
  }

  function renderGaoxinRow(idx, item) {
    const it = item || {};
    return `<div class="sh-form-row" style="align-items:center;margin-bottom:2px;">
      <select onchange="window._shUpdateGaoxin(${idx},'dayIdx',parseInt(this.value))" style="flex:1;font-size:10px;">
        <option value="">选择日期</option>
        ${[0,1,2,3,4].map(d=>`<option value="${d}" ${it.dayIdx===d?'selected':''}>${A.DAYS[d]}</option>`).join('')}
      </select>
      <select onchange="window._shUpdateGaoxin(${idx},'doctorId',this.value)" style="flex:1;font-size:10px;">
        <option value="">选择医生</option>
        ${state.doctors.filter(dc=>dc.type!=='trainee').map(dc=>`<option value="${dc.id}" ${it.doctorId===dc.id?'selected':''}>${dc.name}</option>`).join('')}
      </select>
      <button class="sh-btn-action sh-btn-danger sh-btn-xs" onclick="window._shRemoveGaoxin(${idx})">✕</button>
    </div>`;
  }

  function renderZitongRow(idx, item) {
    const it = item || {};
    return `<div class="sh-form-row" style="align-items:center;margin-bottom:2px;">
      <select onchange="window._shUpdateZitong(${idx},'dayIdx',parseInt(this.value))" style="flex:1;font-size:10px;">
        <option value="">选择日期</option>
        ${[0,1,2,3,4].map(d=>`<option value="${d}" ${it.dayIdx===d?'selected':''}>${A.DAYS[d]}</option>`).join('')}
      </select>
      <select onchange="window._shUpdateZitong(${idx},'doctorId',this.value)" style="flex:1;font-size:10px;">
        <option value="">选择医生</option>
        ${state.doctors.filter(dc=>dc.type!=='trainee').map(dc=>`<option value="${dc.id}" ${it.doctorId===dc.id?'selected':''}>${dc.name}</option>`).join('')}
      </select>
      <button class="sh-btn-action sh-btn-danger sh-btn-xs" onclick="window._shRemoveZitong(${idx})">✕</button>
    </div>`;
  }

  function renderSimpleRow(idx, item) {
    const it = item || {};
    return `<div class="sh-form-row" style="align-items:center;margin-bottom:2px;">
      <select onchange="window._shUpdateSimple(${idx},'dayIdx',parseInt(this.value))" style="flex:1;font-size:10px;">
        <option value="">日期</option>
        ${[0,1,2,3,4,5,6].map(d=>`<option value="${d}" ${it.dayIdx===d?'selected':''}>${A.DAYS[d]}</option>`).join('')}
      </select>
      <select onchange="window._shUpdateSimple(${idx},'slot',this.value)" style="flex:0.7;font-size:10px;">
        <option value="">时段</option><option value="am" ${it.slot==='am'?'selected':''}>上午</option><option value="pm" ${it.slot==='pm'?'selected':''}>下午</option>
      </select>
      <select onchange="window._shUpdateSimple(${idx},'doctorId',this.value)" style="flex:1;font-size:10px;">
        <option value="">医生</option>
        ${state.doctors.filter(dc=>dc.type!=='trainee').map(dc=>`<option value="${dc.id}" ${it.doctorId===dc.id?'selected':''}>${dc.name}</option>`).join('')}
      </select>
      <button class="sh-btn-action sh-btn-danger sh-btn-xs" onclick="window._shRemoveSimple(${idx})">✕</button>
    </div>`;
  }

  // ===== 步骤3：特殊安排 =====
  function renderStep3_Special(body) {
    let html = `<div class="sh-info-bar info">💡 为每位医生设置特殊安排（产假/事假/休/二线/培训/开会/医疗保障）。</div>`;

    html += `<label>选择医生</label>
      <select id="sh-special-doc" onchange="window._shRenderSpecialForm()">
        <option value="">— 请选择 —</option>
        ${state.doctors.map(d=>`<option value="${d.id}">${d.name} (#${d.number})</option>`).join('')}
      </select>
      <div id="sh-special-form" style="margin-top:6px;"></div>`;

    html += `<div class="sh-btn-group" style="margin-top:10px;">
      <button class="sh-btn-action sh-btn-outline" onclick="window._shGoToStep(2)">← 上一步</button>
      <button class="sh-btn-action sh-btn-primary" onclick="window._shGoToStep(4)" style="margin-left:auto;">下一步 →</button>
    </div>`;
    body.innerHTML = html;
  }

  function renderSpecialDocForm() {
    const select = document.getElementById('sh-special-doc');
    const formDiv = document.getElementById('sh-special-form');
    if (!select || !formDiv) return;

    const docId = select.value;
    if (!docId) { formDiv.innerHTML = ''; return; }
    const doc = getDoctor(docId);
    if (!state.special) state.special = {};
    if (!state.special[docId]) state.special[docId] = {};

    let html = `<div style="font-weight:600;font-size:12px;margin-bottom:2px;">${doc.name}</div>`;
    html += `<div class="sh-btn-group">`;
    html += `<button class="sh-btn-action sh-btn-xs sh-btn-outline" onclick="window._shToggleAllSpecial(true,'${docId}')">全选</button>`;
    html += `<button class="sh-btn-action sh-btn-xs sh-btn-outline" onclick="window._shToggleAllSpecial(false,'${docId}')">取消</button>`;
    html += `<button class="sh-btn-action sh-btn-xs sh-btn-outline" onclick="window._shToggleWorkdaySpecial('${docId}')">工作日</button>`;
    html += `</div>`;

    // 批量应用
    html += `<div class="sh-form-row" style="margin:6px 0;">
      <select id="sh-batch-special-type" style="flex:1;font-size:10px;">
        <option value="">选择类型</option>${A.SPECIAL_TYPES.map(t=>`<option value="${t}">${t}</option>`).join('')}
      </select>
      <button class="sh-btn-action sh-btn-primary sh-btn-sm" onclick="window._shBatchSpecial('${docId}')">应用</button>
      <button class="sh-btn-action sh-btn-danger sh-btn-sm" onclick="window._shBatchClearSpecial('${docId}')">清除</button>
    </div>`;

    for (let d = 0; d < 7; d++) {
      const sp = (state.special[docId] || {})[d] || { am: null, pm: null };
      const bg = A.isHoliday(state.workdayConfig, d) ? '#fffbe6' : '#fafafa';
      html += `<div style="margin-bottom:2px;padding:3px 6px;background:${bg};border-radius:4px;font-size:10px;display:flex;align-items:center;gap:4px;">
        <strong style="min-width:28px;">${A.DAYS[d]}</strong>`;
      for (let sl of A.SLOTS) {
        html += `<label style="display:flex;align-items:center;gap:2px;flex:1;font-size:9px;">
          <input type="checkbox" class="sh-special-chk" data-doc="${docId}" data-day="${d}" data-slot="${sl}">
          ${A.SLOT_LABELS[sl]}
          <select onchange="window._shUpdateSpecial('${docId}',${d},'${sl}',this.value)" style="flex:1;font-size:10px;">
            <option value="">—</option>${A.SPECIAL_TYPES.map(t=>`<option value="${t}" ${sp[sl]===t?'selected':''}>${t}</option>`).join('')}
          </select></label>`;
      }
      html += `<span style="font-size:8px;color:#999;min-width:40px;text-align:right;">${sp.am||'—'}/${sp.pm||'—'}</span></div>`;
    }

    formDiv.innerHTML = html;
  }

  // ===== 步骤4：值班排班 =====
  function renderStep4_Duty(body) {
    if (!state.dutyOrder || state.dutyOrder.length !== 8) {
      state.dutyOrder = A.buildDefaultDutyOrder(state.doctors);
    }
    const order = state.dutyOrder || [];
    const pool = A.getDutyDoctorPool(state.doctors);
    const flags = state.baiban1Flags || [];

    let html = `<div class="sh-info-bar info">💡· 拖拽排序值班医生。<br>· 节假日中班自动转休。<br>· 先清空再执行重新排班。</div>`;

    html += `<div style="font-weight:600;font-size:12px;">📋 值班序列 (${order.filter(id=>id&&getDoctor(id)).length}/8)</div>`;
    html += `<div id="sh-duty-order">`;

    for (let i = 0; i < 8; i++) {
      const docId = order[i] || '';
      const doc = getDoctor(docId);
      html += `<div class="sh-duty-row" draggable="true" data-index="${i}"
        ondragstart="window._shDragStart(event,${i})" ondragend="window._shDragEnd(event)"
        ondragover="event.preventDefault()" ondrop="window._shDrop(event,${i})">
        <span class="sh-drag-handle">⋮⋮</span>
        <select onchange="window._shUpdateDutyOrder(${i},this.value)" style="flex:1;max-width:110px;font-size:10px;">
          <option value="">— 空 —</option>
          ${pool.map(d=>`<option value="${d.id}" ${docId===d.id?'selected':''}>${d.name}</option>`).join('')}
        </select>
        <span class="sh-duty-desc">${A.getDutyRowDesc(state.workdayConfig, i)}</span>
      </div>`;
    }
    html += `</div>`;

    html += `<div class="sh-btn-group" style="margin-top:6px;">
      <button class="sh-btn-action sh-btn-outline sh-btn-sm" onclick="window._shResetDutyOrder()">🔄 默认顺序</button>
      <label style="font-size:10px;display:flex;align-items:center;gap:4px;margin-left:auto;">
        <input type="checkbox" onchange="state.cancelPreHolidayZhongban=this.checked" ${state.cancelPreHolidayZhongban?'checked':''}> 假前一天取消中班
      </label>
    </div>
    <button class="sh-btn-action sh-btn-primary sh-btn-block" onclick="window._shRunAutoDuty()">🤖 执行自动排班</button>
    <button class="sh-btn-action sh-btn-danger sh-btn-block" onclick="window._shClearDuty()">🗑 清空值班</button>`;

    if (flags.length > 0) {
      html += `<div class="sh-info-bar warn" style="margin-top:6px;">⚠️ ${flags.length}个冲突需处理</div>`;
    }

    html += `<div class="sh-btn-group" style="margin-top:10px;">
      <button class="sh-btn-action sh-btn-outline" onclick="window._shGoToStep(3)">← 上一步</button>
      <button class="sh-btn-action sh-btn-primary" onclick="window._shGoToStep(5)" style="margin-left:auto;">下一步 →</button>
    </div>`;
    body.innerHTML = html;
  }

  // ===== 步骤5：调整确认 =====
  function renderStep5_Confirm(body) {
    const flags = state.baiban1Flags || [];
    const trainees = state.doctors.filter(d => d.type === 'trainee');

    let html = `<div class="sh-info-bar info">💡 处理冲突、规培生同步，最后提交。</div>`;

    // 冲突
    html += `<div style="font-weight:600;font-size:12px;">（一）冲突处理</div>`;
    if (flags.length > 0) {
      html += `<ul class="sh-conflict-list">`;
      for (let f of flags) {
        const resolved = !!f.resolvedBy;
        html += `<li class="${resolved?'resolved':''}">
          <span>${resolved?'ℹ️':'⚠️'}</span>
          <span style="flex:1;">${f.reason}</span>
          <span style="font-size:9px;">${A.DAYS[f.dayIdx]}${A.SLOT_LABELS[f.slot]}</span>
          ${resolved? '' : `<button class="sh-btn-action sh-btn-primary sh-btn-xs" onclick="window._shQuickBaiban1(${f.dayIdx},'${f.slot}')">分配白1</button>`}
        </li>`;
      }
      html += `</ul>`;
    } else {
      html += `<div class="sh-info-bar success">✅ 无冲突</div>`;
    }

    // 一键填空
    html += `<div style="font-weight:600;font-size:12px;margin-top:8px;">（二）一键填空</div>
      <button class="sh-btn-action sh-btn-primary sh-btn-block" onclick="window._shFillEmpty()">🪣 空白→白班普/休</button>`;

    // 规培生
    if (trainees.length > 0) {
      html += `<div style="font-weight:600;font-size:12px;margin-top:8px;">（三）规培生同步</div>
        <button class="sh-btn-action sh-btn-success sh-btn-block" onclick="window._shSyncTrainees()">🔄 ${trainees.map(d=>d.name).join('、')} 应用导师排班</button>`;
    }

    // 统计
    const stats = A.computeWeekStats(state);
    html += `<div style="font-weight:600;font-size:12px;margin-top:8px;">📊 统计</div>
      <div style="font-size:10px;">${Object.entries(stats).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`<span style="display:inline-block;margin:2px;padding:1px 6px;background:${A.TYPE_COLORS[k]}22;border-radius:8px;border:1px solid ${A.TYPE_COLORS[k]}44;">${k}:${v}次</span>`).join('')||'暂无'}</div>`;

    // 提交
    html += `<div class="sh-divider"></div>
      <button class="sh-btn-action sh-btn-primary sh-btn-block" onclick="window._shSubmitAll()">✅ 提交所有修改</button>
      <div class="sh-btn-group" style="margin-top:6px;">
        <button class="sh-btn-action sh-btn-outline" onclick="window._shGoToStep(4)">← 上一步</button>
      </div>`;
    body.innerHTML = html;
  }

  // ==================== 暴露到全局window以供onclick调用 ====================
  window._shGoToStep = goToStep;
  window._shToggleWorkday = function (d) {
    if (!state.workdayConfig) state.workdayConfig = [true,true,true,true,true,false,false];
    state.workdayConfig[d] = !state.workdayConfig[d];
    renderPanel();
    syncStateToBackground();
  };

  window._shUpdateGeneral = function (dayIdx, slot, doctorId) {
    if (!state.outpatientGeneral[dayIdx]) state.outpatientGeneral[dayIdx] = { am: null, pm: null };
    state.outpatientGeneral[dayIdx][slot] = doctorId || null;
    syncStateToBackground();
  };

  window._shAddGaoxin = function () {
    if (!state.outpatientGaoxin) state.outpatientGaoxin = [];
    state.outpatientGaoxin.push({ dayIdx: null, doctorId: null });
    renderPanel();
  };
  window._shUpdateGaoxin = function (idx, field, value) {
    if (!state.outpatientGaoxin) state.outpatientGaoxin = [];
    if (!state.outpatientGaoxin[idx]) state.outpatientGaoxin[idx] = { dayIdx: null, doctorId: null };
    state.outpatientGaoxin[idx][field] = (value || value === 0) ? value : null;
    syncStateToBackground();
  };
  window._shRemoveGaoxin = function (idx) {
    state.outpatientGaoxin.splice(idx, 1);
    renderPanel();
  };

  window._shAddZitong = function () {
    if (!state.outpatientZitong) state.outpatientZitong = [];
    state.outpatientZitong.push({ dayIdx: null, doctorId: null });
    renderPanel();
  };
  window._shUpdateZitong = function (idx, field, value) {
    if (!state.outpatientZitong) state.outpatientZitong = [];
    if (!state.outpatientZitong[idx]) state.outpatientZitong[idx] = { dayIdx: null, doctorId: null };
    state.outpatientZitong[idx][field] = (value || value === 0) ? value : null;
    syncStateToBackground();
  };
  window._shRemoveZitong = function (idx) {
    state.outpatientZitong.splice(idx, 1);
    renderPanel();
  };

  window._shAddSimple = function () {
    if (!state.outpatientSimple) state.outpatientSimple = [];
    state.outpatientSimple.push({ dayIdx: null, doctorId: null, slot: null });
    renderPanel();
  };
  window._shUpdateSimple = function (idx, field, value) {
    if (!state.outpatientSimple) state.outpatientSimple = [];
    if (!state.outpatientSimple[idx]) state.outpatientSimple[idx] = { dayIdx: null, doctorId: null, slot: null };
    state.outpatientSimple[idx][field] = (value || value === 0) ? value : null;
    syncStateToBackground();
  };
  window._shRemoveSimple = function (idx) {
    state.outpatientSimple.splice(idx, 1);
    renderPanel();
  };

  window._shRenderSpecialForm = renderSpecialDocForm;
  window._shToggleAllSpecial = function (on, docId) {
    document.querySelectorAll(`.sh-special-chk[data-doc="${docId}"]`).forEach(cb => cb.checked = on);
  };
  window._shToggleWorkdaySpecial = function (docId) {
    document.querySelectorAll(`.sh-special-chk[data-doc="${docId}"]`).forEach(cb => {
      cb.checked = (state.workdayConfig || [])[parseInt(cb.dataset.day)];
    });
  };
  window._shUpdateSpecial = function (docId, dayIdx, slot, type) {
    if (!state.special) state.special = {};
    if (!state.special[docId]) state.special[docId] = {};
    if (!state.special[docId][dayIdx]) state.special[docId][dayIdx] = { am: null, pm: null };
    state.special[docId][dayIdx][slot] = type || null;
    syncStateToBackground();
  };
  window._shBatchSpecial = function (docId) {
    const type = document.getElementById('sh-batch-special-type')?.value;
    if (!type) { showToast('请选择类型', 'warn'); return; }
    const checked = [...document.querySelectorAll(`.sh-special-chk[data-doc="${docId}"]:checked`)];
    if (!checked.length) { showToast('请勾选时段', 'warn'); return; }
    if (!state.special) state.special = {};
    if (!state.special[docId]) state.special[docId] = {};
    checked.forEach(cb => {
      const day = parseInt(cb.dataset.day), slot = cb.dataset.slot;
      if (!state.special[docId][day]) state.special[docId][day] = { am: null, pm: null };
      state.special[docId][day][slot] = type;
    });
    renderSpecialDocForm();
    syncStateToBackground();
    showToast(`已应用 ${type} ×${checked.length}`, 'success');
  };
  window._shBatchClearSpecial = function (docId) {
    const checked = [...document.querySelectorAll(`.sh-special-chk[data-doc="${docId}"]:checked`)];
    if (!checked.length) { showToast('请勾选时段', 'warn'); return; }
    if (!state.special) state.special = {};
    if (!state.special[docId]) state.special[docId] = {};
    checked.forEach(cb => {
      const day = parseInt(cb.dataset.day), slot = cb.dataset.slot;
      if (!state.special[docId][day]) state.special[docId][day] = { am: null, pm: null };
      state.special[docId][day][slot] = null;
    });
    renderSpecialDocForm();
    showToast(`已清除 ×${checked.length}`, 'success');
  };

  window._shUpdateDutyOrder = function (idx, docId) {
    if (!state.dutyOrder) state.dutyOrder = [];
    while (state.dutyOrder.length < 8) state.dutyOrder.push('');
    state.dutyOrder[idx] = docId || '';
    renderPanel();
    syncStateToBackground();
  };
  window._shResetDutyOrder = function () {
    state.dutyOrder = A.buildDefaultDutyOrder(state.doctors);
    renderPanel();
  };
  window._shRunAutoDuty = function () {
    const filled = (state.dutyOrder || []).filter(id => id && getDoctor(id)).length;
    if (!filled) { showToast('请先设置值班序列', 'warn'); return; }
    if (!confirm('执行自动排班？已有安排不会被覆盖。')) return;

    const result = A.computeAutoDuty(state);
    state.dutyAssigned = result.dutyAssigned;
    state.baiban1Flags = result.baiban1Flags;
    renderPanel();
    syncStateToBackground();

    const conflicts = state.baiban1Flags.filter(f => f.isConflict).length;
    if (conflicts > 0) {
      showToast(`排班完成！${conflicts}个冲突需处理`, 'warn');
    } else {
      showToast('排班完成，无冲突！', 'success');
    }
  };
  window._shClearDuty = function () {
    if (!confirm('清空所有值班安排？')) return;
    state.dutyAssigned = {};
    state.baiban1Flags = [];
    renderPanel();
  };

  window._shQuickBaiban1 = function (dayIdx, slot) {
    const candidates = A.getBaiban1Candidates(state, dayIdx, slot);
    if (!candidates.length) { showToast('无可用医生', 'warn'); return; }
    const names = candidates.map(d => `${d.name}(#${d.number})`).join('\n');
    const choice = prompt(`选择白班1医生（${A.DAYS[dayIdx]}${A.SLOT_LABELS[slot]}）:\n\n${names}\n\n输入序号:`);
    if (!choice) return;
    const idx = parseInt(choice) - 1;
    if (idx < 0 || idx >= candidates.length) { showToast('无效选择', 'error'); return; }
    const doc = candidates[idx];
    if (!state.dutyAssigned) state.dutyAssigned = {};
    if (!state.dutyAssigned[doc.id]) state.dutyAssigned[doc.id] = {};
    if (!state.dutyAssigned[doc.id][dayIdx]) state.dutyAssigned[doc.id][dayIdx] = { am: null, pm: null };
    state.dutyAssigned[doc.id][dayIdx][slot] = '白班1';
    state.baiban1Flags = A.resolveConflict(state.baiban1Flags, dayIdx, slot, doc.id, doc.name);
    renderPanel();
    syncStateToBackground();
  };

  window._shFillEmpty = function () {
    const result = A.computeFillEmpty(state);
    state.dutyAssigned = result.dutyAssigned;
    renderPanel();
    syncStateToBackground();
    showToast(`已填补 ${result.count} 个空缺`, 'success');
  };

  window._shSyncTrainees = function () {
    const result = A.computeTraineeSync(state);
    state.dutyAssigned = result.dutyAssigned;
    state.traineeFlags = result.traineeFlags;
    renderPanel();
    syncStateToBackground();
    showToast('规培生已同步导师排班', 'success');
  };

  window._shSubmitAll = submitAllChanges;

  // ==================== 拖拽排序 ====================
  let dragSrcIdx = null;
  window._shDragStart = function (e, idx) { dragSrcIdx = idx; };
  window._shDragEnd = function () { dragSrcIdx = null; };
  window._shDrop = function (e, targetIdx) {
    e.preventDefault();
    if (dragSrcIdx === null || dragSrcIdx === targetIdx) return;
    const order = state.dutyOrder || [];
    let insertIdx = dragSrcIdx > targetIdx ? targetIdx : targetIdx + 1;
    if (dragSrcIdx < insertIdx) insertIdx--;
    const [moved] = order.splice(dragSrcIdx, 1);
    order.splice(insertIdx, 0, moved);
    dragSrcIdx = null;
    renderPanel();
    syncStateToBackground();
  };

  // ==================== 启动 ====================
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  console.log('[排班辅助] Content Script 已加载');
})();
