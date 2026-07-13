/**
 * 页面主世界 fetch 桥接脚本
 * 此文件通过 <script src> 注入到页面 DOM，在页面主世界运行，天然拥有页面 Cookie。
 * 与 Content Script 通过 window.postMessage 通信。
 */
(function () {
  'use strict';

  // 避免重复注入
  if (window.__scheduleBridgeReady) return;
  window.__scheduleBridgeReady = true;

  var LOG_PREFIX = '[排班辅助·桥]';
  console.log(LOG_PREFIX, '页面主世界 fetch 桥已就绪, 当前页面URL:', window.location.href);

  // 通知 Content Script：bridge 已就绪
  window.postMessage({ type: '__SCHEDULE_BRIDGE_READY__' }, '*');
  console.log(LOG_PREFIX, '📤 已发送 bridge 就绪消息给 Content Script');

  // ==================== Token 自动探测 ====================
  var _authHeaderName = 'Authorization';

  /**
   * 从存储值中提取 token。支持：
   *   1. 纯 token 字符串（JWT / Bearer xxx / 长随机串）
   *   2. JSON 对象，token 在嵌套字段中（如 {token: "xxx"}）
   *   3. 双重 JSON 编码（如 "\"{\\"token\\":\\"xxx\\"}\"" → 递归解析）
   * @param {string} rawValue - localStorage 中的原始值
   * @param {string} sourceName - 来源描述（用于日志）
   * @returns {{token: string, prefix: string}|null}
   */
  function extractTokenFromValue(rawValue, sourceName) {
    if (!rawValue) return null;

    // ---- 策略1: 尝试 JSON.parse（支持对象和双重编码）----
    try {
      var parsed = JSON.parse(rawValue);
      console.log(LOG_PREFIX, '    JSON.parse 成功, 类型=' + typeof parsed +
        (typeof parsed === 'object' && !Array.isArray(parsed) ? ', keys=' + Object.keys(parsed).join(',') : ''));

      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // 解析结果是对象，查找内部 token 字段
        var nestedTokenFields = ['token', 'access_token', 'accessToken', 'jwt', 'JWT',
          'id_token', 'idToken', 'authToken', 'auth_token'];
        for (var i = 0; i < nestedTokenFields.length; i++) {
          var nestedVal = parsed[nestedTokenFields[i]];
          if (nestedVal && typeof nestedVal === 'string' && nestedVal.length > 10) {
            console.log(LOG_PREFIX, '    ↳ 从对象字段 "' + nestedTokenFields[i] + '" 提取到 token, 长度=' + nestedVal.length);
            var isJwt = (nestedVal.split('.').length === 3 && nestedVal.length > 50);
            return { token: nestedVal, prefix: isJwt ? 'Bearer ' : '' };
          }
        }
        // 检查是否有长字符串字段像 token
        for (var objKey in parsed) {
          if (parsed.hasOwnProperty(objKey)) {
            var objVal = parsed[objKey];
            if (typeof objVal === 'string' && objVal.length > 30 && objVal.indexOf(' ') === -1) {
              console.log(LOG_PREFIX, '    ↳ 从对象字段 "' + objKey + '" 提取到疑似 token, 长度=' + objVal.length);
              return { token: objVal, prefix: (objVal.split('.').length === 3 ? 'Bearer ' : '') };
            }
          }
        }
        return null;
      }

      // 解析结果是字符串 → 可能是双重 JSON 编码，递归再解析一次
      if (typeof parsed === 'string' && parsed.length > 5) {
        console.log(LOG_PREFIX, '    ↳ JSON.parse 返回字符串（可能是双重编码），递归解析...长度=' + parsed.length + ', 前30字符=' + parsed.substring(0, 30));
        return extractTokenFromValue(parsed, sourceName + '->inner');
      }

      // 解析结果是数组或其他类型，无法处理
      console.log(LOG_PREFIX, '    JSON.parse 返回非对象/非字符串类型:', typeof parsed);
    } catch (e) {
      console.log(LOG_PREFIX, '    JSON.parse 失败: ' + e.message + '，尝试纯字符串模式');
    }

    // ---- 策略2: 值是纯 token 字符串 ----
    var trimmed = rawValue.trim();

    // Bearer token
    if (trimmed.toLowerCase().indexOf('bearer ') === 0) {
      return { token: trimmed.substring(7).trim(), prefix: 'Bearer ' };
    }
    // Basic auth
    if (trimmed.toLowerCase().indexOf('basic ') === 0) {
      return { token: trimmed, prefix: '' };
    }
    // JWT（三段 base64）
    if (trimmed.split('.').length === 3 && trimmed.length > 50) {
      return { token: trimmed, prefix: 'Bearer ' };
    }
    // 长字符串（可能是自定义 token）
    if (trimmed.length > 20 && trimmed.indexOf(' ') === -1) {
      return { token: trimmed, prefix: '' };
    }

    return null;
  }

  /**
   * 获取当前有效的认证 token（每次调用都重新从存储读取，不缓存）
   * @returns {{token: string, prefix: string}|null}
   */
  function getAuthToken() {
    // 常见的 token key 名称（按优先级排列）
    var candidateKeys = [
      'login_user', 'loginUser', 'user_info', 'userInfo', 'user',
      'currentUser', 'current_user', 'userData', 'user_data',
      'session', 'Session', 'auth_data', 'authData',
      'token', 'access_token', 'accessToken', 'access-token',
      'jwt', 'JWT', 'jwtToken', 'jwt_token',
      'authorization', 'Authorization', 'auth', 'authToken', 'auth_token',
      'x-token', 'x-access-token', 'X-Access-Token',
      'satoken', 'sa-token', 'SaToken',
      'Admin-Token', 'admin-token', 'adminToken',
      'umi_token', 'umi-token'
    ];

    // 检查已知候选 key
    for (var i = 0; i < candidateKeys.length; i++) {
      var key = candidateKeys[i];
      var val = localStorage.getItem(key) || sessionStorage.getItem(key);
      if (!val) continue;

      var extracted = extractTokenFromValue(val, key);
      if (extracted) {
        console.log(LOG_PREFIX, '🔑 从 ' + (localStorage.getItem(key) ? 'localStorage' : 'sessionStorage') +
          '.' + key + ' 提取到 token, prefix="' + extracted.prefix + '", 前20字符=' + extracted.token.substring(0, 20) + '...');
        return extracted;
      }
    }

    // 遍历所有键（仅当候选都没匹配到时）
    var allKeys = Object.keys(localStorage).concat(Object.keys(sessionStorage));
    for (var j = 0; j < allKeys.length; j++) {
      var k = allKeys[j];
      if (candidateKeys.indexOf(k) !== -1) continue; // 已检查过
      var kLower = k.toLowerCase();
      if (kLower.indexOf('token') !== -1 || kLower.indexOf('auth') !== -1 ||
          kLower.indexOf('jwt') !== -1 || kLower.indexOf('login') !== -1 ||
          kLower.indexOf('user') !== -1 || kLower.indexOf('session') !== -1) {
        var v = localStorage.getItem(k) || sessionStorage.getItem(k);
        if (!v) continue;
        var ext = extractTokenFromValue(v, k);
        if (ext) {
          console.log(LOG_PREFIX, '🔑 遍历发现 ' + k + ' 包含 token, prefix="' + ext.prefix + '"');
          return ext;
        }
      }
    }

    console.warn(LOG_PREFIX, '⚠️ 未找到 Token！localStorage keys:', Object.keys(localStorage),
      'sessionStorage keys:', Object.keys(sessionStorage));
    return null;
  }

  // 启动时打印存储信息（仅一次，便于调试）
  console.log(LOG_PREFIX, '🔍 localStorage 键:', Object.keys(localStorage));
  console.log(LOG_PREFIX, '🔍 sessionStorage 键:', Object.keys(sessionStorage));
  // ==================== Token 探测结束 ====================

  window.addEventListener('message', async function (event) {
    // 安全校验：仅处理同源消息
    if (event.source !== window) return;
    if (!event.data || event.data.type !== '__SCHEDULE_API_REQ__') return;

    var id = event.data.id;
    var url = event.data.url;
    var options = event.data.options || {};

    var urlPath = url.replace(/^https?:\/\/[^\/]+/, '');
    var method = options.method || 'GET';
    console.log(LOG_PREFIX, '📨 收到请求 #' + id + ':', method, urlPath,
      options.body ? (' body=' + options.body.substring(0, 200)) : '');

    var startTime = Date.now();

    try {
      // 每次请求前实时从存储读取 token（不缓存，确保始终使用最新 token）
      var authInfo = getAuthToken();

      // 构建请求头
      var reqHeaders = Object.assign({}, options.headers || {});
      // 只在非 GET 请求时加 Content-Type（GET 请求不需要，且可能导致 CORS preflight）
      if (method !== 'GET' && method !== 'HEAD') {
        reqHeaders['Content-Type'] = reqHeaders['Content-Type'] || 'application/json';
      }
      // 如果有 token，添加到请求头
      if (authInfo) {
        reqHeaders[_authHeaderName] = authInfo.prefix + authInfo.token;
        console.log(LOG_PREFIX, '🔑 请求 #' + id + ' 附带 Token: ' + _authHeaderName + ': ' + authInfo.prefix + authInfo.token.substring(0, 20) + '...');
      } else {
        console.warn(LOG_PREFIX, '⚠️ 请求 #' + id + ' 没有 Token，可能返回 401！');
      }

      // 在页面主世界执行 fetch，天然附带所有 Cookie（含 httpOnly）
      var fetchOptions = {
        method: method,
        credentials: 'include',
        headers: reqHeaders
      };
      // 仅 POST/PUT 等方法才附带 body
      if (options.body) {
        fetchOptions.body = options.body;
      }

      console.log(LOG_PREFIX, '🔧 请求 #' + id + ' fetch 参数:',
        'method=' + fetchOptions.method,
        'credentials=' + fetchOptions.credentials,
        'headers=' + JSON.stringify(fetchOptions.headers).substring(0, 300),
        'body=' + (fetchOptions.body ? fetchOptions.body.substring(0, 200) : '(无)'));

      var resp = await fetch(url, fetchOptions);
      var elapsed = Date.now() - startTime;

      console.log(LOG_PREFIX, '📥 请求 #' + id + ' 响应:',
        'status=' + resp.status,
        'statusText=' + resp.statusText,
        '耗时=' + elapsed + 'ms',
        'content-type=' + resp.headers.get('content-type'));

      var text = await resp.text();
      console.log(LOG_PREFIX, '📄 请求 #' + id + ' 响应体 (前500字符):', text.substring(0, 500));

      var data;
      try {
        data = JSON.parse(text);
        console.log(LOG_PREFIX, '✅ 请求 #' + id + ' JSON解析成功, 顶层结构:', Object.keys(data).join(', '),
          data.error !== undefined ? ('error=' + data.error) : '(无error字段)');
      } catch (e) {
        console.warn(LOG_PREFIX, '⚠️ 请求 #' + id + ' JSON解析失败, 将原始文本放入data字段:', e.message);
        data = { error: -1, data: text };
      }

      window.postMessage({
        type: '__SCHEDULE_API_RES__',
        id: id,
        data: data
      }, '*');

      console.log(LOG_PREFIX, '📤 请求 #' + id + ' 响应已通过 postMessage 发回 Content Script');
    } catch (err) {
      var elapsed = Date.now() - startTime;
      console.error(LOG_PREFIX, '❌ 请求 #' + id + ' fetch 异常 (' + elapsed + 'ms):',
        'URL=' + urlPath,
        '错误=' + err.message,
        'name=' + err.name,
        'stack=' + (err.stack || '').substring(0, 300));

      window.postMessage({
        type: '__SCHEDULE_API_RES__',
        id: id,
        error: err.message + ' (name=' + err.name + ')'
      }, '*');
      console.log(LOG_PREFIX, '📤 请求 #' + id + ' 错误信息已通过 postMessage 发回');
    }
  });
})();
