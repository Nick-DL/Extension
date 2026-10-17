/**
 * Background Service Worker (Manifest V3)
 * 管理扩展状态、处理跨页面消息通信
 */

// ==================== 扩展全局状态 ====================
let extensionState = {
  enabled: false,           // 是否对当前页面启用辅助插件
  activeTabId: null,        // 当前激活的页面ID
  scheduleState: null,      // 排班状态快照（从content script同步）
  originalData: null,       // API原始数据备份
  classMap: {},             // 班型名称→classId 映射
  locationId: '',           // 院区ID
  weekInfo: null,           // { year, week, monday }
  isIntercepting: false     // 是否正在拦截API
};

// ==================== 生命周期 ====================
chrome.runtime.onInstalled.addListener(() => {
  console.log('[排班辅助] 扩展已安装');
  // 初始化存储
  chrome.storage.local.set({ extensionState });
});

// ==================== 截图传输窗口 ====================
const TRANSFER_WINDOW_KEY = 'transferWindowInfo';

function readTransferWindow() {
  return new Promise((resolve) => {
    try {
      chrome.storage.session.get([TRANSFER_WINDOW_KEY], (result) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve((result && result[TRANSFER_WINDOW_KEY]) || null);
      });
    } catch (err) { resolve(null); }
  });
}

function writeTransferWindow(info) {
  return new Promise((resolve) => {
    try {
      if (info) {
        chrome.storage.session.set({ [TRANSFER_WINDOW_KEY]: info }, () => resolve());
      } else {
        chrome.storage.session.remove(TRANSFER_WINDOW_KEY, () => resolve());
      }
    } catch (err) { resolve(); }
  });
}

/**
 * 打开（或复用）截图传输窗口
 * @param {number} sourceTabId 发起入口所在的排班标签页
 */
async function openTransferWindow(sourceTabId) {
  const tabId = Number(sourceTabId) || null;
  if (!tabId) return { success: false, error: '没有找到要截图的排班页面' };

  const existing = await readTransferWindow();
  if (existing && existing.windowId) {
    try {
      const win = await chrome.windows.get(existing.windowId);
      if (win) {
        await writeTransferWindow({ windowId: existing.windowId, sourceTabId: tabId });
        await chrome.windows.update(existing.windowId, { focused: true });
        // 已经打开的传输窗口：换一个目标标签页，由页面自己重置流程
        chrome.runtime.sendMessage({ type: 'TRANSFER_SET_SOURCE', sourceTabId: tabId }, () => {
          void chrome.runtime.lastError;
        });
        return { success: true, windowId: existing.windowId, reused: true };
      }
    } catch (err) {
      // 窗口已经关闭，继续创建新的
    }
  }

  const url = chrome.runtime.getURL('oft/send.html') + '?tab=' + encodeURIComponent(tabId);
  const win = await chrome.windows.create({
    url,
    type: 'popup',
    width: 1120,
    height: 860,
    focused: true
  });
  await writeTransferWindow({ windowId: win.id, sourceTabId: tabId });
  return { success: true, windowId: win.id };
}

chrome.windows.onRemoved.addListener((windowId) => {
  readTransferWindow().then((info) => {
    if (info && info.windowId === windowId) writeTransferWindow(null);
  });
});

// ==================== 消息处理 ====================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[排班辅助 BG] 收到消息:', message.type);

  switch (message.type) {
    case 'GET_STATE':
      sendResponse({ success: true, data: extensionState });
      break;

    case 'SET_ENABLED':
      extensionState.enabled = message.enabled;
      extensionState.activeTabId = sender.tab?.id || null;
      saveState();
      // 通知content script启用/禁用（保留 force 标志，供非排班页面临时启用）
      notifyContentScript(sender.tab?.id, {
        type: 'TOGGLE_ENABLED',
        enabled: message.enabled,
        force: message.force
      });
      sendResponse({ success: true });
      break;

    case 'UPDATE_SCHEDULE_STATE':
      extensionState.scheduleState = message.scheduleState;
      saveState();
      sendResponse({ success: true });
      break;

    case 'UPDATE_ORIGINAL_DATA':
      extensionState.originalData = message.data;
      saveState();
      sendResponse({ success: true });
      break;

    case 'UPDATE_CLASS_MAP':
      extensionState.classMap = message.classMap;
      saveState();
      sendResponse({ success: true });
      break;

    case 'UPDATE_LOCATION':
      extensionState.locationId = message.locationId;
      saveState();
      sendResponse({ success: true });
      break;

    case 'UPDATE_WEEK_INFO':
      extensionState.weekInfo = message.weekInfo;
      saveState();
      sendResponse({ success: true });
      break;

    case 'SET_INTERCEPTING':
      extensionState.isIntercepting = message.intercepting;
      saveState();
      sendResponse({ success: true });
      break;

    case 'GET_PREV_WEEK_DATA':
      // 从存储中读取上周数据
      chrome.storage.local.get(['prevWeekData'], (result) => {
        sendResponse({ success: true, data: result.prevWeekData || null });
      });
      return true; // 异步响应

    case 'SAVE_PREV_WEEK_DATA':
      chrome.storage.local.set({ prevWeekData: message.data }, () => {
        sendResponse({ success: true });
      });
      return true;

    case 'REGISTER_TEST_SCRIPTS':
      registerTestScripts(message.patterns)
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'UNREGISTER_TEST_SCRIPTS':
      unregisterTestScripts()
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'OPEN_TRANSFER': {
      const targetTabId = message.tabId || (sender.tab && sender.tab.id);
      openTransferWindow(targetTabId)
        .then(res => sendResponse(res))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'GET_TRANSFER_TARGET':
      readTransferWindow()
        .then((info) => {
          if (!info) { sendResponse({ success: false }); return; }
          if (message.windowId && info.windowId !== message.windowId) {
            sendResponse({ success: false, sourceTabId: null });
            return;
          }
          sendResponse({ success: true, sourceTabId: info.sourceTabId, windowId: info.windowId });
        })
        .catch(() => sendResponse({ success: false }));
      return true;

    default:
      sendResponse({ success: false, error: 'Unknown message type' });
  }

  return true; // 保持消息通道开放
});

// ==================== 辅助函数 ====================
function saveState() {
  chrome.storage.local.set({ extensionState });
}

function notifyContentScript(tabId, message) {
  if (tabId) {
    chrome.tabs.sendMessage(tabId, message).catch(() => {
      console.log('[排班辅助] content script未响应');
    });
  }
}

// ==================== 动态Content Script注册 ====================
const TEST_SCRIPT_ID = 'scheduling-helper-test';

/**
 * 注册测试页面的 content script（由 popup 触发）
 * @param {string[]} patterns - URL 匹配模式数组
 */
async function registerTestScripts(patterns) {
  if (!patterns || patterns.length === 0) {
    await unregisterTestScripts();
    return;
  }

  // 校验是否为合法 match pattern
  const validPatterns = patterns.filter(p => {
    try {
      // match pattern 格式: <scheme>://<host>/<path>
      // 常见合法格式: http://localhost/* , file:///* , *://*.example.com/*
      return p.includes('://') && p.includes('/');
    } catch { return false; }
  });

  if (validPatterns.length === 0) {
    throw new Error('没有有效的URL匹配模式。格式示例: http://localhost/* 或 file:///C:/path/*');
  }

  console.log('[排班辅助 BG] 注册测试脚本, 匹配模式:', validPatterns);

  try {
    // 先注销旧的
    await unregisterTestScripts();
  } catch { /* 忽略首次注册 */ }

  try {
    await chrome.scripting.registerContentScripts([{
      id: TEST_SCRIPT_ID,
      matches: validPatterns,
      js: ['lib/algorithm.js', 'lib/api.js', 'content/content.js', 'content/screenshot.js'],
      css: ['content/floating-panel.css'],
      runAt: 'document_end',
      persistAcrossSessions: true
    }]);
    console.log('[排班辅助 BG] 测试脚本注册成功');
  } catch (err) {
    console.error('[排班辅助 BG] 注册失败:', err);
    throw new Error(`注册失败: ${err.message}。请确认已在扩展管理页面开启"允许访问文件网址"（如使用 file:// 模式）。`);
  }
}

/**
 * 注销测试页面 content script
 */
async function unregisterTestScripts() {
  try {
    const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: [TEST_SCRIPT_ID] });
    if (scripts && scripts.length > 0) {
      await chrome.scripting.unregisterContentScripts({ ids: [TEST_SCRIPT_ID] });
      console.log('[排班辅助 BG] 测试脚本已注销');
    }
  } catch { /* 忽略 */ }
}
