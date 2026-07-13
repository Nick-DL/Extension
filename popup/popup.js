/**
 * Popup 页面逻辑
 */

let currentState = { enabled: false, weekInfo: null };

// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', async () => {
  // ---- 绑定事件监听器（替代内联onclick/onchange，避免CSP违规） ----
  document.getElementById('enableToggle').addEventListener('change', function () {
    onToggleEnable(this.checked);
  });
  document.getElementById('testModeToggle').addEventListener('change', function () {
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

  // 加载测试模式配置
  chrome.storage.local.get(['testMode', 'testPatterns'], (result) => {
    document.getElementById('testModeToggle').checked = result.testMode || false;
    document.getElementById('testUrlInput').value = (result.testPatterns || []).join('\n');
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

// ==================== 事件处理 ====================
async function onToggleEnable(enabled) {
  try {
    await chrome.runtime.sendMessage({ type: 'SET_ENABLED', enabled });
    currentState.enabled = enabled;
    updateUI(currentState);

    // 通知content script
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_ENABLED', enabled }).catch(() => {});
    }
  } catch (e) {
    console.error('[Popup] 切换启用状态失败:', e);
  }
}

function openFloatingPanel() {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { type: 'OPEN_PANEL' }).catch(() => {});
    }
  });
}

function refreshData() {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { type: 'REFRESH_DATA' }).catch(() => {});
    }
  });
}

function restoreData() {
  if (!confirm('确定要恢复原始备份数据？当前所有修改将丢失。')) return;
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { type: 'RESTORE_DATA' }).catch(() => {});
    }
  });
}

function onToggleTestMode(enabled) {
  chrome.storage.local.set({ testMode: enabled });
  if (enabled) {
    // 通知 background 注册测试脚本
    chrome.storage.local.get(['testPatterns'], (result) => {
      const patterns = result.testPatterns || [];
      if (patterns.length > 0) {
        chrome.runtime.sendMessage({ type: 'REGISTER_TEST_SCRIPTS', patterns });
      }
    });
  } else {
    chrome.runtime.sendMessage({ type: 'UNREGISTER_TEST_SCRIPTS' });
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
