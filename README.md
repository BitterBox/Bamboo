# 竹 (Bamboo)

一个轻量级 LLM 聊天客户端，支持桌面端（Electron）和浏览器端运行。

## 功能

### 核心聊天
- **多会话管理** — 创建、切换、重命名、删除会话，自动生成会话标题
- **对话树** — 支持从任意消息节点分叉对话，可视化对话分支结构
- **流式响应** — 实时接收模型输出，支持中途取消
- **消息操作** — 编辑、删除、重试消息，支持截断后继续生成
- **思考链显示** — 推理模型的思考过程以可折叠块展示，流式输出时自动展开，完成后收起

### 模型与服务商
- **多服务商管理** — 添加多个 API 服务商（不同 baseURL / 密钥），一键切换
- **模型列表** — 从 API 拉取可用模型，勾选激活；自动识别模型能力类型（对话/推理/向量/视觉）
- **智能适配** — 推理模型自动跳过 temperature，向量模型自动从聊天下拉框过滤
- **快捷切换器** — 聊天界面顶部可快速切换模型

### 角色系统
- 角色作为会话分组容器，每个角色可绑定系统提示词、独立 API 配置、快捷短语
- 内置默认角色「随便聊聊」不可删除

### Markdown 渲染
- GFM（表格、任务列表）、代码块语法高亮
- LaTeX 数学公式（KaTeX）

### MCP 工具调用（桌面端）
LLM 可自主发起工具调用（Agentic Loop，最多 200 轮）：

| 类别 | 工具 |
|------|------|
| 文件 | `read_file` / `write_file` / `list_directory` / `search` |
| 代码 | `analyze_code` / `modify_code` / `suggest_refactorings` |
| 批量 | 原子事务提交、回滚 |
| Python | 隔离沙箱执行，自动检测 Conda 环境 |
| Web | `fetch_url` 网页抓取 |

### 其他
- **词数 / Token 统计** — 消息气泡下方实时显示
- **文件导入** — PDF / 文本文件导入，内容发送给模型
- **文件管理** — `/files` 浏览、删除已导入文件
- **快捷键** — 内置常用快捷键，可录制自定义
- **外观配置** — 字号、行距、段间距可调
- **API 请求预览** — `/inspector` 查看实际发送的请求体

## 技术栈

| 分类 | 技术 |
|------|------|
| UI 框架 | React 19 + TypeScript |
| 路由 | React Router 7 |
| 状态管理 | Zustand 5 |
| 动画 | Framer Motion |
| LLM 接入 | OpenAI SDK 6（兼容接口） |
| Markdown | react-markdown + remark-gfm + remark-math + rehype-katex |
| 数学 | KaTeX |
| PDF 解析 | pdfjs-dist |
| 桌面端 | Electron 40 |
| 构建 | Vite 7 |

## 快速开始

```bash
# 安装依赖
pnpm install

# 浏览器开发模式（localhost:5173）
pnpm dev                  # 或双击 viteCore.bat

# Electron 开发模式
pnpm dev:electron         # 或双击 electronWindows.bat

# 构建 Web 产物
pnpm build

# 构建桌面安装包
pnpm build:electron
```

## 路由

| 路径 | 页面 | 说明 |
|------|------|------|
| `/` | Chat | 主聊天界面 |
| `/settings` | Settings | 配置管理 |
| `/inspector` | RequestInspector | API 请求预览 |
| `/files` | FileManager | 文件管理 |

## 设置说明

### 模型配置
添加 API 服务商（名称、端点、密钥）→ 获取模型列表 → 勾选激活 → 下拉框选择。支持 Temperature、Max Tokens、Top K 精细控制。

### 外观
字号（10–22px）、行距（1.0–2.2）、段间距（0–1.0em），滑条与数字输入联动，实时预览。

### 快捷键

| 默认按键 | 操作 |
|----------|------|
| `Alt+E` | 编辑最后一条消息 |
| `Alt+D` | 删除最后一条消息 |
| `Alt+R` | 重试最后一条消息 |
| `Alt+T` | 继续生成（截断后） |
| `Alt+C` | 复制最后一条消息 |
| `Ctrl+Shift+K` | 清空当前对话 |

输入框聚焦时自动禁用，可在设置中录制自定义快捷键。

### MCP（工具调用）
仅桌面端可用。启用后 LLM 可调用文件、代码、Python、Web 等工具。可在设置中配置允许访问的目录、最大循环轮数。

### 角色管理
角色作为会话分组容器，侧边栏按角色展示会话列表。每个角色可独立配置系统提示词、快捷短语、API 服务商和模型。

## 项目结构

```
bamboo/
├── electron/
│   ├── main.js              # 主进程：IPC 处理、窗口管理、MCP 后端
│   ├── preload.js           # Context Bridge：渲染进程 API 暴露
│   ├── batchManager.js      # 批量写入事务系统
│   ├── codeTools.js         # 代码分析（TypeScript AST）
│   ├── lockManager.js       # 目录级写锁管理
│   └── pythonSandbox.js     # Python 隔离执行引擎
├── src/
│   ├── types/
│   │   ├── index.ts         # 全局类型定义
│   │   └── electron.d.ts    # ElectronAPI 接口类型
│   ├── store/
│   │   ├── settingsStore.ts # 配置、角色、服务商管理
│   │   ├── chatStore.ts     # 多会话消息、对话树、流式状态
│   │   └── persistence.ts   # 持久化策略
│   ├── services/
│   │   ├── llm.ts            # OpenAI 流式请求、tool_calls
│   │   ├── llmUtils.ts       # 工具函数、模型能力检测
│   │   ├── settingsCompat.ts # 配置兼容层（旧格式迁移）
│   │   ├── autoNameService.ts # 会话自动命名
│   │   ├── fileManager.ts    # 文件导入/管理
│   │   ├── rateLimiter.ts    # API 速率限制
│   │   └── mcp/
│   │       ├── registry.ts       # 工具注册表
│   │       ├── fileTools.ts      # 文件读写工具
│   │       ├── codeTools.ts      # 代码分析工具
│   │       ├── pythonTools.ts    # Python 沙箱工具
│   │       ├── webTools.ts       # 网页抓取工具
│   │       ├── permissionAware.ts # 路径权限管理
│   │       ├── types.ts
│   │       └── index.ts
│   ├── hooks/
│   │   ├── useChat.ts                   # 核心聊天 + Agentic Loop
│   │   ├── useKeyboardShortcuts.ts      # 全局快捷键
│   │   ├── useBatchCommitCoordinator.ts # 批量提交流程
│   │   ├── useAutoCommitNotify.ts       # 自动提交通知
│   │   ├── useResumePausedSessions.ts   # 会话恢复
│   │   ├── useFileImport.ts             # 文件导入处理
│   │   └── useScrollNavigation.ts       # 滚动导航
│   ├── components/
│   │   ├── chat/
│   │   │   ├── ChatHeader.tsx       # 聊天头部
│   │   │   ├── ChatInput.tsx        # 输入框
│   │   │   ├── MessageItem.tsx      # 消息气泡
│   │   │   ├── RightPanel.tsx       # 右侧栏
│   │   │   ├── ScrollButtons.tsx    # 滚动按钮
│   │   │   └── ToolResultBlock.tsx  # 工具结果展示
│   │   ├── ConversationTree.tsx     # 对话树
│   │   ├── SessionList.tsx          # 会话列表
│   │   ├── Layout.tsx               # 主布局
│   │   ├── MarkdownContent.tsx      # Markdown 渲染
│   │   ├── ModelSwitcher.tsx        # 模型切换器
│   │   ├── ModelConfigModal.tsx     # 模型配置弹窗
│   │   ├── JsonViewer.tsx           # JSON 查看器
│   │   ├── Modal.tsx                # 通用弹窗
│   │   ├── SetupGate.tsx            # 首次配置引导
│   │   ├── DataLoader.tsx           # 启动数据加载
│   │   └── icons.tsx                # SVG 图标集
│   ├── pages/
│   │   ├── Chat.tsx                 # 主聊天界面
│   │   ├── Settings.tsx             # 设置页
│   │   ├── RequestInspector.tsx     # API 请求预览
│   │   └── FileManager.tsx          # 文件管理
│   ├── utils/
│   │   ├── chatConstants.ts         # 常量
│   │   ├── countStats.ts            # 词数/Token 统计
│   │   ├── fileImport.ts            # 文件导入
│   │   ├── reconcileToolCalls.ts    # 工具调用协调
│   │   ├── scrollCache.ts           # 滚动缓存
│   │   ├── sessionHelpers.ts        # 会话辅助
│   │   └── treeUtils.ts             # 对话树工具
│   ├── App.tsx
│   └── main.tsx
├── index.html
├── vite.config.ts
├── viteCore.bat              # 快捷：浏览器开发模式
├── electronWindows.bat       # 快捷：Electron 开发模式
└── package.json
```

## 数据持久化

**Electron 桌面端：**
```
<userData>/config/app-config.json   # 应用配置
<dataDir>/settings.json             # LLM 配置 + 快捷键 + 角色
<dataDir>/sessions/                 # 会话数据（v4 拆分格式）
<dataDir>/chat-index.json           # 会话索引
<dataDir>/file/                     # 导入文件存储
```

**浏览器端：**
```
localStorage: app-settings          # 所有配置
localStorage: chat-history          # 聊天记录
```

## 注意事项

- 浏览器端直接调用 LLM API 涉及 CORS，建议通过代理或使用桌面端
- API 密钥存储在本地，请勿在公共环境使用
