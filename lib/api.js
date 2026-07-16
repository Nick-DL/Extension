/**
 * API 通信层 - 封装对排班系统的 HTTP 请求
 *
 * Manifest V3 Content Script 的 fetch 不自动附带页面 Cookie（含 httpOnly）。
 * 解决方案：将 fetch 代理脚本（bridge.js）以外部文件形式注入页面 DOM，
 * 利用 CSP 已放行的 chrome-extension:// 协议，在页面主世界执行 fetch。
 */

const ScheduleAPI = (function () {
  'use strict';

  const BASE = 'http://10.66.66.151';
  const API_PREFIX = '/api/biz/attendance';

  // ==================== 页面主世界 fetch 桥 ====================
  const _pendingRequests = new Map();
  let _requestId = 0;
  let _bridgeInjected = false;
  let _bridgeReadyPromise = null;
  let _bridgeReadyResolve = null;

  /**
   * 通过 <script src="bridge.js"> 注入页面主世界代理（外部文件，CSP 允许）
   * 返回 Promise，在 bridge 就绪后 resolve
   */
  function _injectBridge() {
    // 如果已有就绪的 Promise 且已 resolve，直接返回
    if (_bridgeReadyPromise && _bridgeInjected) {
      return _bridgeReadyPromise;
    }

    // 如果正在注入中，返回已有的 Promise
    if (_bridgeReadyPromise) {
      return _bridgeReadyPromise;
    }

    // 创建新的 Promise
    _bridgeReadyPromise = new Promise(function (resolve) {
      _bridgeReadyResolve = resolve;
    });

    // 避免重复注入
    if (document.getElementById('__schedule_api_bridge')) {
      console.log('[ScheduleAPI] bridge DOM 元素已存在，等待其就绪消息...');
      // 设置 5 秒超时，避免永久卡住
      setTimeout(function () {
        if (!_bridgeInjected) {
          console.warn('[ScheduleAPI] ⚠️ bridge 就绪等待超时（5s），强制标记为已就绪');
          _bridgeInjected = true;
          if (_bridgeReadyResolve) { _bridgeReadyResolve(); _bridgeReadyResolve = null; }
        }
      }, 5000);
      return _bridgeReadyPromise;
    }

    try {
      var bridgeUrl = chrome.runtime.getURL('lib/bridge.js');

      var script = document.createElement('script');
      script.id = '__schedule_api_bridge';
      script.src = bridgeUrl;

      script.onload = function () {};
      script.onerror = function (err) {
        console.error('[ScheduleAPI] bridge.js 加载失败', err);
        _bridgeInjected = false;
        _bridgeReadyPromise = null;
        if (_bridgeReadyResolve) { _bridgeReadyResolve(); _bridgeReadyResolve = null; }
        var el = document.getElementById('__schedule_api_bridge');
        if (el) el.remove();
      };

      (document.head || document.documentElement).appendChild(script);

      // 设置 5 秒超时，避免永久卡住
      setTimeout(function () {
        if (!_bridgeInjected) {
          console.warn('[ScheduleAPI] ⚠️ bridge 就绪等待超时（5s），强制标记为已就绪');
          _bridgeInjected = true;
          if (_bridgeReadyResolve) { _bridgeReadyResolve(); _bridgeReadyResolve = null; }
        }
      }, 5000);
    } catch (err) {
      console.error('[ScheduleAPI] ❌ bridge 注入异常:', err);
      _bridgeInjected = false;
      _bridgeReadyPromise = null;
      if (_bridgeReadyResolve) { _bridgeReadyResolve(); _bridgeReadyResolve = null; }
    }

    return _bridgeReadyPromise;
  }

  // 监听页面主世界 bridge 返回的响应（包括就绪消息和 API 响应）
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    if (!event.data) return;

    // bridge 就绪消息
    if (event.data.type === '__SCHEDULE_BRIDGE_READY__') {
      _bridgeInjected = true;
      if (_bridgeReadyResolve) {
        _bridgeReadyResolve();
        _bridgeReadyResolve = null;
      }
      return;
    }

    // API 响应消息
    if (event.data.type === '__SCHEDULE_API_RES__') {
      var id = event.data.id;
      var resolver = _pendingRequests.get(id);
      if (!resolver) return;
      _pendingRequests.delete(id);

      if (event.data.error) {
        console.error('[ScheduleAPI] 请求 #' + id + ' bridge错误:', event.data.error);
        resolver.reject(new Error(event.data.error));
      } else {
        resolver.resolve(event.data.data);
      }
      return;
    }

    // Fiber 周切换响应消息
    if (event.data.type === '__SCHEDULE_FIBER_RES__') {
      var fid = event.data.id;
      var fresolver = _pendingRequests.get(fid);
      if (!fresolver) return;
      _pendingRequests.delete(fid);

      if (event.data.success) {
        fresolver.resolve(event.data.data);
      } else {
        fresolver.reject(new Error(event.data.error || 'fiber switch failed'));
      }
      return;
    }
  });

  /**
   * 通用请求方法（通过页面主世界代理执行）
   */
  async function request(url, options) {
    options = options || {};

    await _injectBridge();

    var urlPath = url.replace(BASE, '');

    return new Promise(function (resolve, reject) {
      var id = ++_requestId;
      _pendingRequests.set(id, { resolve: resolve, reject: reject });

      // 30 秒超时
      var timer = setTimeout(function () {
        _pendingRequests.delete(id);
        console.error('[ScheduleAPI] ⏰ 请求 #' + id + ' 超时 (30s):', urlPath);
        resolve({ error: -1, data: null, message: '请求超时' });
      }, 30000);

      // 保证超时时清除
      var entry = _pendingRequests.get(id);
      var origResolve = entry.resolve;
      var origReject = entry.reject;
      _pendingRequests.set(id, {
        resolve: function (data) { clearTimeout(timer); origResolve(data); },
        reject: function (err) { clearTimeout(timer); console.error('[ScheduleAPI] ❌ 请求 #' + id + ' reject:', urlPath, err.message); origReject(err); }
      });

      window.postMessage({
        type: '__SCHEDULE_API_REQ__',
        id: id,
        url: url,
        options: options
      }, '*');
    }).then(function (rawData) {
      if (!rawData) return { error: -1, data: null, message: '响应为空' };
      if (typeof rawData === 'object' && !Array.isArray(rawData)) {
        if (rawData.error !== undefined && rawData.success === false) {
          console.warn('[ScheduleAPI] API错误:', urlPath, rawData.error);
          return { error: rawData.error, data: null, message: rawData.error };
        }
        if (rawData.success === false)
          return { error: -1, data: null, message: rawData.error || '请求失败' };
      }
      return { error: 0, data: rawData };
    }).catch(function (err) {
      console.error('[ScheduleAPI] 请求异常:', urlPath, err.message);
      return { error: -1, data: null, message: err.message };
    });
  }

  /** GET 请求 */
  async function get(path, params = {}) {
    const url = new URL(BASE + API_PREFIX + path);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    });
    return request(url.toString());
  }

  /** POST 请求（kb 方法） */
  async function post(path, body = {}) {
    return request(BASE + API_PREFIX + path, {
      method: 'POST',
      body: JSON.stringify(body)
    });
  }

  /** POST JSON body（hc/gc 方法） */
  async function postJson(path, data) {
    return request(BASE + API_PREFIX + path, {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  // ==================== 数据读取接口 ====================

  /**
   * 获取员工列表
   * @param {object} params
   * @param {string} params.from - 开始日期 YYYY-MM-DD
   * @param {string} params.to - 结束日期 YYYY-MM-DD
   * @param {object} params.query - 查询条件
   * @returns {Promise<{error, data}>}
   */
  async function fetchEmployees(params = {}) {
    const { from, to, query, page = 1, pageSize = 50 } = params;
    return get('/att_employee', {
      from, to, schedule: 1, page, pageSize,
      fovs: 1,
      query: query ? JSON.stringify(query) : undefined,
      columns: params.columns || undefined
    });
  }

  /**
   * 获取员工排班详细数据
   * @param {object} params
   * @param {string[]} params.empIds - 员工ID数组
   * @param {string} params.from
   * @param {string} params.to
   * @returns {Promise<{error, data}>}
   */
  async function fetchEmpSchedules(params = {}) {
    const { empIds, from, to, query } = params;
    return get('/empSchedules', {
      empIds: empIds ? empIds.join(',') : undefined,
      from, to, fetchGroup: 1, vacation: 1, alias: 1,
      query: query ? JSON.stringify(query) : undefined
    });
  }

  /**
   * 获取所有班型（班次类型）
   * @returns {Promise<{error, data}>}
   */
  async function fetchClasses() {
    return get('/att_class', { all: 1, fovs: 1, usual: 1 });
  }

  /**
   * 获取院区列表
   * @returns {Promise<{error, data}>}
   */
  async function fetchLocations() {
    return get('/att_schedule_location', { all: 1 });
  }

  /**
   * 获取排班组成员
   * @returns {Promise<{error, data}>}
   */
  async function fetchGroupEmps() {
    return get('/scheduleGroupEmps');
  }

  /**
   * 获取排班报表数据
   * @param {object} params
   */
  async function fetchScheduleReport(params = {}) {
    const { empIds, from, to, query } = params;
    return get('/empScheduleReport', {
      empIds: empIds ? empIds.join(',') : undefined,
      from, to, location: params.location,
      isDeptStat: params.isDeptStat,
      query: query ? JSON.stringify(query) : undefined
    });
  }

  // ==================== 数据写入接口 ====================

  /**
   * 批量设置/追加班型（核心写入接口）
   * POST /api/biz/attendance/appendUsualClass
   * @param {Array<{empId: string, workDate: string, classId: string, locationId?: string}>} batchData
   * @returns {Promise<{error, data}>}
   */
  async function appendUsualClass(batchData) {
    return postJson('/appendUsualClass', batchData);
  }

  /**
   * 批量清除班型（classId 传 null）
   * @param {Array<{empId: string, workDate: string, classId: null}>} batchData
   * @returns {Promise<{error, data}>}
   */
  async function clearSchedules(batchData) {
    return postJson('/appendUsualClass', batchData.map(d => ({ ...d, classId: null })));
  }

  /**
   * 保存班次备注
   * @param {object} params
   */
  async function updateScheduleMemo(params = {}) {
    return postJson('/updateScheduleMemo', params);
  }

  /**
   * 保存人员排序
   * @param {string[]} empIds
   */
  async function saveEmployeeOrder(empIds) {
    return postJson('/employeeDisplayOrder', empIds);
  }

  // ==================== 工具函数 ====================

  /**
   * 从 API 数据构建扩展内部用的 doctor 列表
   * 仅包含排班类别为"医疗"和人员类别为"规培协议"（规培生）/其他（医生）
   * @param {Array} employees - 从 fetchEmployees 返回的员工列表
   * @returns {Array} 扩展内部 Doctor 对象数组
   */
  function buildDoctorsFromAPI(employees) {
    if (!employees || !Array.isArray(employees)) return [];

    console.log('[ScheduleAPI] buildDoctorsFromAPI: 输入', employees.length, '条员工记录');
    console.log('[ScheduleAPI] 第一条员工全部字段:', JSON.stringify(employees[0], null, 2));

    // 辅助函数：从多个候选字段中取值
    function getField(emp, candidates) {
      for (var i = 0; i < candidates.length; i++) {
        var val = emp[candidates[i]];
        if (val !== undefined && val !== null) return val;
      }
      return undefined;
    }

    var result = [];
    var skipped = { notMedicalNorTraining: 0, noIdOrName: 0 };
    for (var i = 0; i < employees.length; i++) {
      var emp = employees[i];

      var scheduleCategory = getField(emp, ['shiftCategories', 'category', 'scheduleCategory', 'scheduleType', '排班类别']);
      var employeeType = getField(emp, ['categoryText', 'employeeType', 'empType', 'personType', '人员类别']);
      var employeeNumber = getField(emp, ['jobNo', 'cardNo', 'empCode', 'workCode', 'jobNumber', '工号']);
      var employeeName = getField(emp, ['name', 'empName', 'employeeName', 'realName', 'displayName', '姓名']);

      // 详细日志：每条记录的字段
      console.log('[ScheduleAPI] 员工#' + i + ':', JSON.stringify({
        dbId: emp.id,
        jobNo: employeeNumber,
        name: employeeName,
        shiftCategories: emp.shiftCategories,
        category: emp.category,
        categoryText: emp.categoryText,
        allKeys: Object.keys(emp)
      }));

      // 排班类别判定：
      // shiftCategories=1 或 '医疗' → 医生体系
      // category=4 或 '规培' → 规培
      var isMedical = (emp.shiftCategories === 1 || emp.shiftCategories === '1' || emp.shiftCategories === '医疗');
      var isTraining = (emp.category === 4 || emp.category === '4' || emp.category === '规培');
      if (!isMedical && !isTraining) {
        console.log('[ScheduleAPI]   ⏭ 跳过: shiftCategories=' + emp.shiftCategories + ' category=' + emp.category + ' (非医疗/规培)');
        skipped.notMedicalNorTraining++;
        continue;
      }

      // 规培生判定（两条规则）：
      // ① 人员类别 categoryText === "规培协议"
      // ② 排班类别 category === 4/规培（即 isTraining）
      var isTrainee = (employeeType === '规培协议' || employeeType === '规培生' ||
                        employeeType === '规培' || employeeType === 'trainee' ||
                        isTraining);

      var doc = {
        id: String(emp.id || emp.empId || ''),
        name: String(employeeName || ''),
        type: isTrainee ? 'trainee' : 'regular',
        number: parseInt(employeeNumber || '0', 10) || 0,
        mentorId: emp.mentorId || null,
        training: emp.training || false,
        onLeave: emp.onLeave || false,
        noDutyDays: emp.noDutyDays || [],
        dutyDays: emp.dutyDays || [],
        _raw: emp
      };
      if (!doc.id || !doc.name) {
        console.log('[ScheduleAPI]   ⏭ 跳过: 缺id或name, id=' + doc.id + ' name=' + doc.name);
        skipped.noIdOrName++;
        continue;
      }
      console.log('[ScheduleAPI]   ✅ 收录: type=' + doc.type + ' num=' + doc.number);
      result.push(doc);
    }
    console.log('[ScheduleAPI] buildDoctorsFromAPI 结果:', result.length, '人, 跳过: 非医疗/规培=' + skipped.notMedicalNorTraining + ' 缺id/name=' + skipped.noIdOrName);
    return result;
  }

  /**
   * 将扩展内部的排班数据转换为 appendUsualClass 所需的格式
   * @param {object} scheduleState - 扩展排班状态
   * @param {object} classMap - 班型名称→classId 映射
   * @param {string} locationId - 院区ID
   * @param {string} weekMonday - 本周一的日期 YYYY-MM-DD
   * @returns {Array<{empId, workDate, classId, locationId}>}
   */
  function buildBatchData(scheduleState, classMap, locationId, weekMonday) {
    const { doctors, dutyAssigned, special, outpatientGeneral, outpatientSimple, outpatientGaoxin, outpatientZitong } = scheduleState;
    const batchData = [];

    // 计算周一到周日的日期
    const monday = new Date(weekMonday);
    const dates = [];
    for (let d = 0; d < 7; d++) {
      const dt = new Date(monday);
      dt.setDate(monday.getDate() + d);
      dates.push(dt.toISOString().slice(0, 10));
    }

    for (let doc of doctors) {
      for (let d = 0; d < 7; d++) {
        for (let s of ['am', 'pm']) {
          const type = ScheduleAlgorithm.getSlotSchedule(scheduleState, doc.id, d, s);
          if (!type) continue;

          const classId = classMap[type];
          if (classId) {
            batchData.push({
              empId: doc.id,
              workDate: dates[d],
              classId: classId,
              locationId: locationId
            });
          }
        }
      }
    }

    return batchData;
  }

  /**
   * 拦截 fetch 请求（用于在插件流程运行期间阻止排班修改API）
   * @returns {function} 取消拦截的函数
   */
  function interceptScheduleAPI() {
    const originalFetch = window.fetch;
    const blockedPatterns = [
      '/api/biz/attendance/appendUsualClass',
      '/api/biz/attendance/updateScheduleMemo',
      '/api/biz/attendance/import/att_emp_schedule',
      '/api/biz/attendance/cancelScheduleAudit'
    ];

    window.fetch = function (url, options) {
      const urlStr = typeof url === 'string' ? url : (url.url || url.toString());
      const isBlocked = blockedPatterns.some(p => urlStr.includes(p));

      if (isBlocked && (options?.method || 'GET').toUpperCase() !== 'GET') {
        console.warn('[排班辅助] 已拦截排班修改请求:', urlStr);
        // 提示用户
        window.dispatchEvent(new CustomEvent('scheduling-api-blocked', {
          detail: { url: urlStr, method: options?.method }
        }));
        return Promise.resolve(new Response(JSON.stringify({
          error: 0,
          data: null,
          message: '排班辅助插件已拦截此操作，请通过辅助面板完成排班后统一提交。'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }

      return originalFetch.apply(this, arguments);
    };

    // 返回恢复函数
    return function restoreFetch() {
      window.fetch = originalFetch;
    };
  }

  // ==================== React Fiber 周切换 ====================

  /**
   * 通过 bridge 在主世界调用 React fiber 的 onChange 切换工作周
   * @param {number} targetWeek - 目标ISO周数
   * @returns {Promise<{year: number, week: number, monday: string}>}
   */
  async function _switchWeek(targetWeek) {
    await _injectBridge();

    return new Promise(function (resolve, reject) {
      var id = ++_requestId;
      _pendingRequests.set(id, { resolve: resolve, reject: reject });

      // 10秒超时
      var timer = setTimeout(function () {
        _pendingRequests.delete(id);
        reject(new Error('fiber切换超时'));
      }, 10000);

      var entry = _pendingRequests.get(id);
      var origResolve = entry.resolve;
      var origReject = entry.reject;
      _pendingRequests.set(id, {
        resolve: function (data) { clearTimeout(timer); origResolve(data); },
        reject: function (err) { clearTimeout(timer); origReject(err); }
      });

      window.postMessage({
        type: '__SCHEDULE_FIBER_SWITCH__',
        id: id,
        targetWeek: targetWeek
      }, '*');
    });
  }

  // ==================== 公开API ====================
  return {
    BASE,
    API_PREFIX,
    request,
    get,
    post,
    postJson,
    fetchEmployees,
    fetchEmpSchedules,
    fetchClasses,
    fetchLocations,
    fetchGroupEmps,
    fetchScheduleReport,
    appendUsualClass,
    clearSchedules,
    updateScheduleMemo,
    saveEmployeeOrder,
    buildDoctorsFromAPI,
    buildBatchData,
    interceptScheduleAPI,
    // React fiber 周切换（通过 bridge 在主世界执行）
    switchWeek: _switchWeek
  };
})();
