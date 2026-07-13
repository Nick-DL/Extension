/**
 * Popup 页面逻辑
 */

let currentState = { enabled: false, weekInfo: null };

// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', async () => {
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
}

function addTestPattern() {
  const input = document.getElementById('testUrlInput').value.trim();
  if (!input) return;
  const patterns = input.split('\n').filter(p => p.trim());

  chrome.storage.local.set({ testPatterns: patterns }, () => {
    // 更新动态content script注册
    if (patterns.length > 0) {
      chrome.scripting.registerContentScripts([{
        id: 'scheduling-helper-test',
        matches: patterns,
        js: ['lib/algorithm.js', 'lib/api.js', 'content/content.js'],
        css: ['content/floating-panel.css'],
        runAt: 'document_end'
      }]).catch(e => console.log('注册测试脚本:', e));
    }
    alert('已添加 ' + patterns.length + ' 个测试页面匹配模式。\n刷新目标页面后生效。');
  });
}
