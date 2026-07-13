/**
 * API 通信层 - 封装对排班系统的 HTTP 请求
 *
 * Manifest V3 Content Script 的 fetch 请求来自扩展上下文，可能不附带页面 Cookie。
 * 解决方案：通过 chrome.cookies API 读取页面域名下的 Cookie，手动附加到请求头。
 */

const ScheduleAPI = (function () {
  'use strict';

  const BASE = 'http://10.66.66.151';
  const API_PREFIX = '/api/biz/attendance';
  const COOKIE_DOMAIN = '10.66.66.151';

  // ==================== Cookie 管理 ====================
  // 缓存 Cookie 字符串，避免每次请求都调 chrome.cookies API
  let _cookieCache = '';
  let _cookieCacheTime = 0;
  const COOKIE_CACHE_TTL = 5000; // 5 秒缓存

  /**
   * 从 chrome.cookies API 获取目标域名下的所有 Cookie，
   * 拼接为 "key1=val1; key2=val2" 格式（含 httpOnly Cookie）
   */
  async function _getCookieHeader() {
    const now = Date.now();
    if (_cookieCache && (now - _cookieCacheTime) < COOKIE_CACHE_TTL) {
      return _cookieCache;
    }

    try {
      const cookies = await chrome.cookies.getAll({ domain: COOKIE_DOMAIN });
      _cookieCache = cookies
        .map(function(c) { return c.name + '=' + c.value; })
        .join('; ');
      _cookieCacheTime = now;
      console.log('[ScheduleAPI] Cookie 已刷新，共', cookies.length, '条');
      return _cookieCache;
    } catch (err) {
      console.warn('[ScheduleAPI] 读取 Cookie 失败，使用缓存或空值:', err.message);
      return _cookieCache || '';
    }
  }

  /**
   * 强制刷新 Cookie 缓存（登录后调用）
   */
  function refreshCookies() {
    _cookieCache = '';
    _cookieCacheTime = 0;
    return _getCookieHeader();
  }

  // ==================== 请求核心 ====================

  /**
   * 通用请求方法
   * @param {string} url - 完整URL
   * @param {object} options - fetch options
   * @returns {Promise<{error: number, data: any}>}
   */
  async function request(url, options = {}) {
    try {
      // 获取页面 Cookie 并附加到请求头
      const cookieStr = await _getCookieHeader();
      const headers = {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      };
      if (cookieStr) {
        headers['Cookie'] = cookieStr;
      }

      const resp = await fetch(url, {
        ...options,
        credentials: 'include',  // 兜底：部分浏览器仍会自动带 Cookie
        headers: headers
      });

      const text = await resp.text();
      try {
        return JSON.parse(text);
      } catch {
        return { error: -1, data: text };
      }
    } catch (err) {
      console.error('[ScheduleAPI] 请求失败:', url, err);
      return { error: -1, data: null, message: err.message };
    }
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

    return employees
      .filter(emp => {
        // 仅保留排班类别为"医疗"或"规培"的
        const scheduleCategory = emp.scheduleCategory || emp['排班类别'] || '';
        return scheduleCategory === '医疗' || scheduleCategory === '规培';
      })
      .map(emp => {
        const isTrainee = (emp.employeeType || emp['人员类别'] || '') === '规培协议';
        return {
          id: String(emp.id || emp.empId || ''),
          name: emp.name || emp.empName || '',
          type: isTrainee ? 'trainee' : 'regular',
          number: parseInt(emp.empCode || emp.workCode || emp['工号'] || '0', 10) || 0,
          mentorId: emp.mentorId || null,
          training: emp.training || false,
          onLeave: emp.onLeave || false,
          noDutyDays: emp.noDutyDays || [],
          dutyDays: emp.dutyDays || [],
          // 保留原始数据以便写回API
          _raw: emp
        };
      });
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

  // ==================== 公开API ====================
  return {
    BASE,
    API_PREFIX,
    request,
    get,
    post,
    postJson,
    refreshCookies,
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
    interceptScheduleAPI
  };
})();
