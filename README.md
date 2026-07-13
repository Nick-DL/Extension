# 排班辅助插件 (Scheduling Helper Extension)

绵阳市第三人民医院 · 科室排班辅助填表工具 — 浏览器扩展（Manifest V3）

## 功能概述

在排班系统页面（`http://10.66.66.151/app/attendance/schedules/hospital`）中提供以下功能：

1. **浮窗操作面板**：5步排班流程（人员→门诊→特殊→值班→确认）
2. **API 拦截**：插件运行期间拦截排班修改请求，统一提交
3. **数据备份/恢复**：操作前自动备份，支持一键恢复
4. **上周数据预置**：门诊和值班数据优先加载上周配置
5. **自动排班算法**：值班中班夜休自动轮排，冲突检测，白班1提示
6. **班型色条**：页面表格下方显示班型标识色
7. **仅限医疗/规培**：自动过滤护理体系人员，不修改其数据

## 项目结构

```
Extension/
├── manifest.json                 # 扩展配置
├── background/
│   └── service-worker.js         # 后台服务（状态管理/消息中转）
├── popup/
│   ├── popup.html                # 扩展弹窗页面
│   └── popup.js                  # 弹窗逻辑
├── content/
│   ├── content.js                # 主内容脚本（核心逻辑+UI）
│   └── floating-panel.css        # 浮窗样式
├── lib/
│   ├── algorithm.js              # 排班核心算法（纯函数模块）
│   └── api.js                    # API 通信层
├── icons/
│   ├── icon.svg                  # 源图标（需转为PNG）
│   ├── icon16.svg
│   └── icon48.svg
└── README.md
```

## 安装方法

### 开发模式安装

1. 打开 Chrome 浏览器，进入 `chrome://extensions/`
2. 开启右上角 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择 `Extension` 文件夹
5. 扩展安装完成

### 生成图标

SVG 图标已提供，需转为 PNG 格式：

```bash
# 使用 ImageMagick（推荐）
magick icons/icon.svg -resize 128x128 icons/icon128.png
magick icons/icon48.svg -resize 48x48 icons/icon48.png
magick icons/icon16.svg -resize 16x16 icons/icon16.png
```

然后在 `manifest.json` 中添加 `icons` 和 `action.default_icon` 配置。

## 使用流程

### 1. 启用插件

- 打开排班系统页面
- 点击浏览器工具栏的扩展图标
- 在弹窗中打开 **"为本页面启用辅助插件"** 开关
- 页面右侧会出现 **"排班辅助"** 快捷入口和浮窗面板

### 2. 五步排班流程

| 步骤 | 内容 | 说明 |
|------|------|------|
| 1. 人员 | 查看人员列表 | 自动从API加载，仅显示医疗/规培类别 |
| 2. 门诊 | 总院/高新/梓潼/简易门诊 | 门诊优先级最高，支持导入上周数据 |
| 3. 特殊 | 产假/事假/培训/开会等 | 按医生+时段批量设置 |
| 4. 值班 | 值班序列+自动排班 | 8排轮转，拖拽排序，冲突检测 |
| 5. 确认 | 冲突处理+提交 | 白班1分配，规培同步，一键填空，最终提交 |

### 3. 提交修改

- 在步骤5点击 **"提交所有修改"**
- 插件将所有排班数据通过 `appendUsualClass` API 批量写入
- 提交成功后刷新页面查看

## API 接口参考

### 数据读取

| 接口 | 用途 |
|------|------|
| `GET /api/biz/attendance/att_employee` | 获取员工列表 |
| `GET /api/biz/attendance/empSchedules` | 获取排班数据 |
| `GET /api/biz/attendance/att_class` | 获取班型列表 |
| `GET /api/biz/attendance/att_schedule_location` | 获取院区列表 |

### 数据写入

| 接口 | 用途 |
|------|------|
| `POST /api/biz/attendance/appendUsualClass` | 批量设置排班（核心） |
| `POST /api/biz/attendance/updateScheduleMemo` | 保存备注 |

### 请求格式

```json
// POST /api/biz/attendance/appendUsualClass
[
  {
    "empId": "员工ID",
    "workDate": "2026-07-13",
    "classId": "班型ID",
    "locationId": "院区ID"
  }
]
```

## 排班规则

### 冲突检测规则

1. 高新/梓潼门诊 + 值班 → 上午需白班1
2. 高新/梓潼门诊 + 中班 → 下午需白班1
3. 上午总院门诊 + 值班 → 上午需白班1
4. 下午总院门诊 + 中班 → 下午需白班1
5. 中班医生当天上午有总院门诊 → 不冲突，跳过
6. 下午总院门诊 + 值班 → 不处理（值班不覆盖门诊）

### 人员分类

- **医疗**：排班类别为"医疗"的医生（含科主任）
- **规培**：人员类别为"规培协议"的规培生
- **护理**：排班类别为"护理"的（**不参与本插件**）

## 技术栈

- Manifest V3
- 纯 JavaScript（无框架依赖）
- Content Script + Background Service Worker
- `chrome.storage.local` 状态持久化
- `fetch` API（`credentials: "include"` 复用登录态）

## 注意事项

1. **API格式需边测试边调整**：`lib/api.js` 中的请求参数和响应解析需根据实际API行为微调
2. **班型名称映射**：`classMap` 的建立依赖系统中班型名称与示例网页一致
3. **上周数据预置**：通过 `empSchedules` API 获取上周数据并缓存到 `chrome.storage`
4. **测试模式**：可在弹窗中添加测试页面URL匹配模式，用于非正式环境测试
5. **页面DOM结构**：`applyToPageTable()` 和 `applyClassColorBar()` 需根据实际页面调整

## 开发调试

1. 打开 `chrome://extensions/`，找到此扩展
2. 点击 **Service Worker** 链接查看后台日志
3. 在目标页面右键 → 检查 → Console 查看 Content Script 日志
4. 所有 `console.log` 输出前缀为 `[排班辅助]`
