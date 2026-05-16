import { useSettingsStore } from '../../store/settingsStore';
import { useChatStore } from '../../store/chatStore';
import { DEFAULT_MCP_CONFIG } from '../../types';
import type { ToolDefinition, MCPConfig } from '../../types';
import { mcpRegistry } from './registry';
import { getToolMeta } from './manifestLoader';

/**
 * 从指定会话直接获取其 MCP 配置（不再回退到智能体或全局配置）
 * 会话的 mcpConfig 在创建时已从智能体快照，创建后独立。
 *
 * @param sessionId 目标会话 ID；省略时使用当前会话，无会话返回默认配置
 */
export function getEffectiveMCPConfig(sessionId?: string | null): MCPConfig {
  const resolvedSessionId = sessionId ?? useChatStore.getState().currentSessionId;
  if (!resolvedSessionId) return { ...DEFAULT_MCP_CONFIG };

  const session = useChatStore.getState().sessions[resolvedSessionId];
  return session?.mcpConfig ?? { ...DEFAULT_MCP_CONFIG };
}

/**
 * 生成 MCP 工具的动态系统提示词
 * 这个提示词应该被注入到 LLM 的 system prompt 中
 *
 * @param mcpConfig 会话的 MCP 配置（已从 Session 直接读取）
 */
export function generateMCPSystemPrompt(mcpConfig: MCPConfig): string {
  const { enabled, fileToolEnabled, codeToolEnabled, allowRead, allowWrite, allowedDirs, pythonToolEnabled, webToolEnabled } = mcpConfig;

  if (!enabled) {
    return "⚠️ MCP 工具调用功能已全局禁用。你无法使用任何工具。";
  }

  if (!fileToolEnabled && !codeToolEnabled && !pythonToolEnabled && !webToolEnabled) {
    return "⚠️ 所有 MCP 工具均已停用。";
  }

  const parts: string[] = [];
  parts.push("# MCP 工具权限状态");

  parts.push("## 当前可用工具：");

  if (fileToolEnabled) {
    if (allowRead) {
      parts.push("- `read_file`: 读取文件内容（支持 offset 和 limit 读取指定行范围，默认读取 75 行，且限制最多 50000 词，防止读取过大或二进制文件）");
      parts.push("- `list_directory`: 列出目录内容");
      parts.push("- `list_recent_commits`: 列出最近的 commit 记录（checkpoint），含描述、时间和文件列表");
    }
    if (allowWrite) {
      parts.push("- `write_file`: 创建新文件（仅限尚未创建的新文件，不会覆盖已有文件。⏳ 修改暂存，需 commit 后生效）");
      parts.push("- `copy_file`: 复制文件到目标路径（目标不能已存在。⏳ 修改暂存，需 commit 后生效）");
      parts.push("- `move_file`: 移动/重命名文件到目标路径（目标不能已存在。⏳ 修改暂存，需 commit 后生效）");
      parts.push("- `batch_commit`: 原子提交所有暂存修改，需提供 `name`（简短名称，用于文件夹命名）和 `description`（详细描述）两个参数");
      parts.push("- `clear_batch_cache`: 清空暂存区，丢弃所有未提交的修改");
      parts.push("- `rollback_to_commit`: 从指定 commit 目录回滚文件到备份时的状态（回滚前自动备份当前状态，可再次回滚撤回）");
    }
  }

  if (codeToolEnabled) {
    if (allowRead) {
      parts.push("- `analyze_code`: 分析代码结构（函数、类、接口、导入、复杂度）");
      parts.push("- `search`: 在文件或目录中搜索指定文本/符号或文件名。当你想查找函数、变量、类、字符串等代码片段或根据文件名查找文件时使用此工具（支持递归搜索文件名和内容，结果过多自动截断）。搜索文本支持正则表达式 /pattern/flags、通配符 * | 以及普通字符串三种模式");
      parts.push("- `suggest_refactorings`: 分析代码并给出重构建议");
    }
    if (allowWrite) {
      parts.push("- `modify_code`: 精确替换文件中的代码片段。修改暂存到缓冲区，需调用 `batch_commit` 后原子生效（**需同时提供三个参数：path、old_string、new_string**）");
    }
  }

  // ── Python 工具 ──
  if (pythonToolEnabled) {
    parts.push("- `run_python`: 在隔离沙箱中执行 Python 代码并返回 stdout/stderr。支持通过 `env_name` 参数指定 Conda 环境（自动检测 conda 路径），适合数据分析、计算验证等编程任务。默认超时 30s，上限 120s。");
  }

  // ── Web 工具 ──
  if (webToolEnabled) {
    parts.push("- `fetch_url`: 访问指定的 http/https URL，获取网页内容或网络文件（仅 GET 请求，自动跟随重定向）。适合读取在线文档、API 响应、公开数据集等。默认超时 30s（上限 60s），响应大小默认 500KB（上限 5MB）。禁止访问内网地址。");
  }

  if (!allowRead && !allowWrite && !pythonToolEnabled) {
    parts.push("❌ 所有工具权限均已禁用。");
  }

  // 目录限制
  parts.push("## 访问权限限制：");
  if (allowedDirs.length > 0) {
    parts.push("📁 仅可访问以下目录（及其子目录）：");
    allowedDirs.forEach((dir, i) => {
      parts.push(`${i + 1}. ${dir}`);
    });
    parts.push("");
    parts.push("重要：所有文件路径必须是完整绝对路径，且必须在上述目录之一或其子目录中。");
  } else {
    parts.push("🚫 文件功能已禁用：未配置允许访问的目录，所有路径均被拒绝访问。");
  }

  // 环境限制
  parts.push("## 环境限制：");
  parts.push("✅ 当前在桌面端（Electron）运行，工具可用");

  // 使用建议
  parts.push("## 使用建议：");
  parts.push("1. 在执行文件操作前，先使用 `list_directory` 查看目录结构");
  parts.push("2. 确保提供的路径是绝对路径（如 C:\\Users\\... 或 /home/user/...）");
  parts.push("3. 注意路径中的反斜杠需要转义或使用正斜杠");
  parts.push("4. 如果遇到权限错误，请检查路径是否在允许的目录列表中");
  parts.push("5. 使用 `modify_code` 时，**三个参数缺一不可**：`path`（目标文件绝对路径）、`old_string`（被替换的旧内容）、`new_string`（替换后的新内容）。同时注意 old_string 必须与文件中的内容完全一致（包括缩进和换行符）");
  parts.push("6. ⚠️ **批量事务规则**：所有 `write_file` / `modify_code` 调用不会立即生效，而是暂存到缓冲区。在你准备回复用户之前，**必须**调用 `batch_commit` 并同时提供 `name`（简短名称，用于文件夹命名）和 `description`（详细描述）两个参数，否则修改将全部丢失。如果中途发现改错了想重来，调用 `clear_batch_cache` 清空暂存区。");
  parts.push("7. ⚠️ **`write_file` 仅限新建**：如果目标文件已存在，`write_file` 会报错。如需修改已有文件，请使用 `modify_code`。");

  return parts.join('\n');
}

/**
 * 获取动态的工具定义（不含权限提示 — 权限信息已通过 generateMCPSystemPrompt 注入到 system prompt 中）
 *
 * @param sessionId 目标会话 ID；省略时使用当前会话
 */
export function getPermissionAwareToolDefinitions(sessionId?: string | null): ToolDefinition[] {
  const config = getEffectiveMCPConfig(sessionId);
  if (!config.enabled) return [];

  const allDefs = mcpRegistry.getDefinitions();

  return allDefs.filter(tool => {
    const name = tool.function.name;
    const meta = getToolMeta(name);

    // 未知工具（未通过 manifestLoader 注册）→ 放行
    if (!meta) return true;

    // 按类别开关过滤
    if (meta.category === 'file' && !config.fileToolEnabled) return false;
    if (meta.category === 'code' && !config.codeToolEnabled) return false;
    if (meta.category === 'python' && !config.pythonToolEnabled) return false;
    if (meta.category === 'web' && !config.webToolEnabled) return false;

    // 按读写权限过滤
    if (meta.read && !config.allowRead) return false;
    if (meta.write && !config.allowWrite) return false;

    return true;
  });
}
