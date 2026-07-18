/**
 * Popup 页面逻辑
 */

let currentState = { enabled: false, weekInfo: null };
let _testModeInitializing = true; // 防止初始化时触发 change 事件

// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', async () => {
  // 动态显示实际版本号
  const manifest = chrome.runtime.getManifest();
  const verEl = document.getElementById('footerVersion');
  if (verEl) verEl.textContent = 'v' + manifest.version;

  // ---- 绑定事件监听器（替代内联onclick/onchange，避免CSP违规） ----
  document.getElementById('enableToggle').addEventListener('change', function () {
    onToggleEnable(this.checked);
  });
  document.getElementById('testModeToggle').addEventListener('change', function () {
    // 初始化阶段跳过（避免从 storage 恢复时重复触发注册）
    if (_testModeInitializing) return;
    onToggleTestMode(this.checked);
  });
  document.getElementById('btnRefreshData').addEventListener('click', refreshData);
  document.getElementById('btnRestoreData').addEventListener('click', restoreData);
  document.getElementById('btnOpenPanel').addEventListener('click', openFloatingPanel);
  document.getElementById('btnAddTestPattern').addEventListener('click', addTestPattern);

  // 加载扩展状态
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (resp.success) {
      currentState = resp.data;
      updateUI(currentState);
    }
  } catch (e) {
    console.error('[Popup] 获取状态失败:', e);
  }

  // 加载测试模式配置（先设值再解除初始化标记，避免触发 change）
  chrome.storage.local.get(['testMode', 'testPatterns'], (result) => {
    _testModeInitializing = true;
    document.getElementById('testModeToggle').checked = result.testMode || false;
    document.getElementById('testUrlInput').value = (result.testPatterns || []).join('\n');
    _testModeInitializing = false;
  });
});

// ==================== UI 更新 ====================
function updateUI(state) {
  const enabled = state.enabled;
  document.getElementById('enableToggle').checked = enabled;

  const statusBar = document.getElementById('statusBar');
  const statusDot = statusBar.querySelector('.status-dot');
  const statusText = document.getElementById('statusText');

  statusBar.className = 'status-bar';
  statusDot.className = 'status-dot';

  if (enabled) {
    statusBar.classList.add('active');
    statusDot.classList.add('active');
    statusText.textContent = '已启用 · 浮窗已打开';
  } else {
    statusBar.classList.add('inactive');
    statusDot.classList.add('inactive');
    statusText.textContent = '已关闭 · 点击开关启用';
  }

  // 显示/隐藏信息区域
  const infoSection = document.getElementById('infoSection');
  const actionSection = document.getElementById('actionSection');

  if (enabled && state.weekInfo) {
    infoSection.style.display = 'block';
    actionSection.style.display = 'block';
    document.getElementById('infoYear').textContent = state.weekInfo.year || '--';
    document.getElementById('infoWeek').textContent = state.weekInfo.week || '--';
    document.getElementById('infoMonday').textContent = state.weekInfo.monday || '--';

    if (state.scheduleState && state.scheduleState.doctors) {
      const docs = state.scheduleState.doctors;
      document.getElementById('infoDocCount').textContent =
        docs.filter(d => d.type === 'regular' || d.type === 'director').length;
      document.getElementById('infoTraineeCount').textContent =
        docs.filter(d => d.type === 'trainee').length;
    }
    document.getElementById('infoClassCount').textContent =
      Object.keys(state.classMap || {}).length || '--';
  } else {
    infoSection.style.display = 'none';
    actionSection.style.display = 'none';
  }
}

// ==================== 辅助：向当前页面 content script 发消息 ====================

/**
 * 获取当前标签页，校验是否支持插件
 * @returns {Promise<{tab: object, isMatch: boolean, isInjected: boolean}>}
 */
async function getCurrentTabInfo() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return { tab: null, isMatch: false, isInjected: false };

  // 检查 URL 是否匹配 manifest content_scripts 的 match 模式
  const url = tab.url || '';
  const isMatch = /10\.66\.66\.151\/app\/attendance\/schedules\/hospital/.test(url) ||
    /^http:\/\/localhost\//.test(url);

  // 尝试 ping content script 判断是否已注入
  let isInjected = false;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
    isInjected = true;
  } catch (e) {
    // content script 未注入
  }

  return { tab, isMatch, isInjected };
}

/**
 * 向当前标签页注入 content scripts（通过 activeTab 权限动态注入）
 * @returns {Promise<boolean>} 是否注入成功
 */
async function injectContentScripts(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['lib/algorithm.js', 'lib/api.js', 'content/content.js']
    });
    await chrome.scripting.insertCSS({
      target: { tabId: tabId },
      files: ['content/floating-panel.css']
    });
    console.log('[Popup] ✅ 已动态注入 content scripts 到 tab', tabId);
    return true;
  } catch (err) {
    console.warn('[Popup] ⚠️ 动态注入失败:', err.message);
    return false;
  }
}

// ==================== 事件处理 ====================

async function onToggleEnable(enabled) {
  try {
    const { tab, isMatch, isInjected } = await getCurrentTabInfo();

    // 先更新 background 状态
    await chrome.runtime.sendMessage({ type: 'SET_ENABLED', enabled });
    currentState.enabled = enabled;
    updateUI(currentState);

    if (!tab) {
      showPopupToast('无法获取当前标签页信息', 'error');
      return;
    }

    if (enabled) {
      // === 启用插件 ===
      if (!isInjected) {
        // 页面没有 content script → 尝试动态注入
        if (tab.url && /^(http|https|file):\/\//.test(tab.url)) {
          showPopupToast('正在为当前页面注入插件...', 'info');
          const injected = await injectContentScripts(tab.id);
          if (injected) {
            // 注入成功后发消息
            await new Promise(r => setTimeout(r, 200)); // 等脚本初始化
            chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_ENABLED', enabled }).catch(() => {});
            showPopupToast('插件已启用！', 'success');
          } else {
            // 注入失败 → 引导用户使用测试模式
            showPopupToast('当前页面不支持直接注入。\n请使用下方「测试模式」添加页面匹配后刷新。', 'error');
            // 回退开关
            document.getElementById('enableToggle').checked = false;
            currentState.enabled = false;
            updateUI(currentState);
            await chrome.runtime.sendMessage({ type: 'SET_ENABLED', enabled: false });
            return;
          }
        } else {
          showPopupToast('此页面类型不支持插件（仅支持 http/https/file 页面）', 'error');
          document.getElementById('enableToggle').checked = false;
          currentState.enabled = false;
          updateUI(currentState);
          await chrome.runtime.sendMessage({ type: 'SET_ENABLED', enabled: false });
          return;
        }
      } else {
        // 已有 content script，直接通知
        chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_ENABLED', enabled }).catch(() => {
          showPopupToast('插件已启用，但页面未响应。请刷新页面后重试。', 'warn');
        });
      }
    } else {
      // === 禁用插件 ===
      if (isInjected) {
        chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_ENABLED', enabled }).catch(() => {});
      }
      showPopupToast('插件已关闭', 'info');
    }
  } catch (e) {
    console.error('[Popup] 切换启用状态失败:', e);
    showPopupToast('操作失败: ' + e.message, 'error');
  }
}

async function openFloatingPanel() {
  const { tab, isInjected } = await getCurrentTabInfo();
  if (!tab) return;
  if (!isInjected) {
    showPopupToast('请先在页面中启用插件开关', 'warn');
    return;
  }
  chrome.tabs.sendMessage(tab.id, { type: 'OPEN_PANEL' }).catch(() => {
    showPopupToast('插件未响应，请刷新页面后重试', 'warn');
  });
}

async function refreshData() {
  const { tab, isInjected } = await getCurrentTabInfo();
  if (!tab) return;
  if (!isInjected) {
    showPopupToast('请先在页面中启用插件开关', 'warn');
    return;
  }
  chrome.tabs.sendMessage(tab.id, { type: 'REFRESH_DATA' }).catch(() => {
    showPopupToast('插件未响应，请刷新页面后重试', 'warn');
  });
}

function restoreData() {
  if (!confirm('确定要恢复原始备份数据？当前所有修改将丢失。')) return;
  chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
    if (!tab) return;
    // 先检查是否已注入
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
    } catch (e) {
      showPopupToast('请先在页面中启用插件开关', 'warn');
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: 'RESTORE_DATA' }).catch(() => {
      showPopupToast('插件未响应，请刷新页面后重试', 'warn');
    });
  });
}

function onToggleTestMode(enabled) {
  chrome.storage.local.set({ testMode: enabled });
  if (enabled) {
    // 通知 background 注册测试脚本
    chrome.storage.local.get(['testPatterns'], (result) => {
      const patterns = result.testPatterns || [];
      if (patterns.length > 0) {
        chrome.runtime.sendMessage({ type: 'REGISTER_TEST_SCRIPTS', patterns }, (resp) => {
          if (resp && resp.success) {
            showPopupToast('测试模式已启用，刷新目标页面生效', 'success');
          } else {
            showPopupToast('测试模式注册失败: ' + (resp?.error || '未知错误'), 'error');
          }
        });
      } else {
        showPopupToast('测试模式已启用，但未设置匹配模式。请在下方添加。', 'warn');
      }
    });
  } else {
    chrome.runtime.sendMessage({ type: 'UNREGISTER_TEST_SCRIPTS' }, (resp) => {
      if (resp && resp.success) {
        showPopupToast('测试模式已关闭', 'info');
      }
    });
  }
}

function addTestPattern() {
  const input = document.getElementById('testUrlInput').value.trim();
  if (!input) {
    showPopupToast('请输入URL匹配模式', 'warn');
    return;
  }
  const patterns = input.split('\n').map(p => p.trim()).filter(p => p);

  // 持久化存储
  chrome.storage.local.set({ testPatterns: patterns }, () => {
    // 通过 background service worker 注册
    chrome.runtime.sendMessage(
      { type: 'REGISTER_TEST_SCRIPTS', patterns },
      (resp) => {
        if (resp && resp.success) {
          showPopupToast(`已注册 ${patterns.length} 个测试页面匹配。刷新目标页面后生效。`, 'success');
        } else {
          showPopupToast('注册失败: ' + (resp?.error || '未知错误'), 'error');
        }
      }
    );
  });
}

function showPopupToast(msg, type) {
  const existing = document.querySelector('.popup-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'popup-toast';
  toast.style.cssText = `
    padding:8px 12px; margin-top:8px; border-radius:6px; font-size:11px;
    ${type==='success'?'background:#f6ffed;color:#389e0d;border:1px solid #b7eb8f':
      type==='error'?'background:#fff2f0;color:#cf1322;border:1px solid #ffccc7':
      'background:#fffbe6;color:#ad6800;border:1px solid #ffe58f'}
  `;
  toast.textContent = msg;
  document.querySelector('.content').appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}
