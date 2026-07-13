/**
 * 页面主世界 fetch 桥接脚本
 * 注入到页面 DOM，在主世界运行，通过 postMessage 与 Content Script 通信。
 */
(function () {
  'use strict';

  if (window.__scheduleBridgeReady) return;
  window.__scheduleBridgeReady = true;

  var LOG_PREFIX = '[排班辅助·桥]';

  // 通知 Content Script：bridge 已就绪
  window.postMessage({ type: '__SCHEDULE_BRIDGE_READY__' }, '*');

  // ==================== Token 自动探测 ====================
  var _authHeaderName = 'Authorization';

  function extractTokenFromValue(rawValue, sourceName) {
    if (!rawValue) return null;

    // 策略1: JSON.parse（支持对象和双重编码）
    try {
      var parsed = JSON.parse(rawValue);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        var nestedTokenFields = ['token', 'access_token', 'accessToken', 'jwt', 'JWT',
          'id_token', 'idToken', 'authToken', 'auth_token'];
        for (var i = 0; i < nestedTokenFields.length; i++) {
          var nestedVal = parsed[nestedTokenFields[i]];
          if (nestedVal && typeof nestedVal === 'string' && nestedVal.length > 10) {
            var isJwt = (nestedVal.split('.').length === 3 && nestedVal.length > 50);
            return { token: nestedVal, prefix: isJwt ? 'Bearer ' : '' };
          }
        }
        for (var objKey in parsed) {
          if (parsed.hasOwnProperty(objKey)) {
            var objVal = parsed[objKey];
            if (typeof objVal === 'string' && objVal.length > 30 && objVal.indexOf(' ') === -1) {
              return { token: objVal, prefix: (objVal.split('.').length === 3 ? 'Bearer ' : '') };
            }
          }
        }
        return null;
      }
      // 双重 JSON 编码
      if (typeof parsed === 'string' && parsed.length > 5) {
        return extractTokenFromValue(parsed, sourceName + '->inner');
      }
    } catch (e) { /* JSON 解析失败，尝试纯字符串 */ }

    // 策略2: 纯 token 字符串
    var trimmed = rawValue.trim();
    if (trimmed.toLowerCase().indexOf('bearer ') === 0)
      return { token: trimmed.substring(7).trim(), prefix: 'Bearer ' };
    if (trimmed.toLowerCase().indexOf('basic ') === 0)
      return { token: trimmed, prefix: '' };
    if (trimmed.split('.').length === 3 && trimmed.length > 50)
      return { token: trimmed, prefix: 'Bearer ' };
    if (trimmed.length > 20 && trimmed.indexOf(' ') === -1)
      return { token: trimmed, prefix: '' };
    return null;
  }

  function getAuthToken() {
    var candidateKeys = [
      'login_user', 'loginUser', 'user_info', 'userInfo', 'user',
      'currentUser', 'current_user', 'userData', 'user_data',
      'session', 'Session', 'auth_data', 'authData',
      'token', 'access_token', 'accessToken', 'access-token',
      'jwt', 'JWT', 'jwtToken', 'jwt_token',
      'authorization', 'Authorization', 'auth', 'authToken', 'auth_token',
      'x-token', 'x-access-token', 'X-Access-Token',
      'satoken', 'sa-token', 'SaToken', 'Admin-Token',
      'umi_token', 'umi-token'
    ];

    for (var i = 0; i < candidateKeys.length; i++) {
      var key = candidateKeys[i];
      var val = localStorage.getItem(key) || sessionStorage.getItem(key);
      if (!val) continue;
      var extracted = extractTokenFromValue(val, key);
      if (extracted) return extracted;
    }

    var allKeys = Object.keys(localStorage).concat(Object.keys(sessionStorage));
    for (var j = 0; j < allKeys.length; j++) {
      var k = allKeys[j];
      if (candidateKeys.indexOf(k) !== -1) continue;
      var kLower = k.toLowerCase();
      if (kLower.indexOf('token') !== -1 || kLower.indexOf('auth') !== -1 ||
          kLower.indexOf('jwt') !== -1 || kLower.indexOf('login') !== -1 ||
          kLower.indexOf('user') !== -1 || kLower.indexOf('session') !== -1) {
        var v = localStorage.getItem(k) || sessionStorage.getItem(k);
        if (!v) continue;
        var ext = extractTokenFromValue(v, k);
        if (ext) return ext;
      }
    }
    console.warn(LOG_PREFIX, '⚠️ 未找到认证 Token');
    return null;
  }
  // ==================== Token 探测结束 ====================

  window.addEventListener('message', async function (event) {
    if (event.source !== window) return;
    if (!event.data || event.data.type !== '__SCHEDULE_API_REQ__') return;

    var id = event.data.id;
    var url = event.data.url;
    var options = event.data.options || {};
    var urlPath = url.replace(/^https?:\/\/[^\/]+/, '');
    var method = options.method || 'GET';

    try {
      var authInfo = getAuthToken();

      var reqHeaders = Object.assign({}, options.headers || {});
      if (method !== 'GET' && method !== 'HEAD') {
        reqHeaders['Content-Type'] = reqHeaders['Content-Type'] || 'application/json';
      }
      if (authInfo) {
        reqHeaders[_authHeaderName] = authInfo.prefix + authInfo.token;
      }

      var fetchOptions = {
        method: method,
        credentials: 'include',
        headers: reqHeaders
      };
      if (options.body) fetchOptions.body = options.body;

      var resp = await fetch(url, fetchOptions);
      var text = await resp.text();

      if (resp.status !== 200) {
        console.error(LOG_PREFIX, '❌ 请求 #' + id, method, urlPath, '→', resp.status, text.substring(0, 200));
      }

      var data;
      try { data = JSON.parse(text); } catch (e) { data = { error: -1, data: text }; }

      window.postMessage({ type: '__SCHEDULE_API_RES__', id: id, data: data }, '*');
    } catch (err) {
      console.error(LOG_PREFIX, '❌ 请求 #' + id + ' fetch异常:', urlPath, err.message);
      window.postMessage({ type: '__SCHEDULE_API_RES__', id: id, error: err.message }, '*');
    }
  });
})();
