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
      // 通知content script启用/禁用
      notifyContentScript(sender.tab?.id, {
        type: 'TOGGLE_ENABLED',
        enabled: message.enabled
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
      // content script可能未加载
      console.log('[排班辅助] content script未响应');
    });
  }
}
