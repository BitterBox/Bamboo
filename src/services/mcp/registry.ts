import type { ToolDefinition, ToolCall } from '../../types';
import type { ToolExecutor } from './types';

/**
 * ── 参数名模糊匹配：LLM 经常误用别名（如 file / filepath 代替 path）──
 *
 * key  → 正确的参数名
 * value → LLM 常见的误输入变体（全部小写，匹配时忽略大小写）
 *
 * 只在正确参数缺失时才从别名取值，已有正确参数时不做覆盖（优先尊重 LLM 意图）。
 */
const PARAM_ALIASES: Record<string, string[]> = {
  path: [
    'file', 'filepath', 'file_path', 'filename', 'file_name',
    'dir', 'directory', 'folder', 'target', 'targetpath', 'target_path',
    'source', 'src',
  ],
};

/**
 * 规范化工具调用参数：
 * 1) 大小写容错 —— LLM 可能把 path 写成 Path / PATH
 * 2) 别名映射 —— LLM 可能误用 file / filepath / directory 等别名
 */
function normalizeArgs(
  rawArgs: Record<string, unknown>,
  definition: ToolDefinition,
): Record<string, unknown> {
  const schema = definition.function.parameters as { properties?: Record<string, unknown> };
  if (!schema?.properties || typeof schema.properties !== 'object') return rawArgs;

  const expectedParams = Object.keys(schema.properties);
  const args = { ...rawArgs };

  // 构建小写 key → 原始 key 的索引
  const lowerToOriginal: Record<string, string> = {};
  for (const key of Object.keys(args)) {
    lowerToOriginal[key.toLowerCase()] = key;
  }

  for (const correctName of expectedParams) {
    const correctLower = correctName.toLowerCase();

    // ── 1. 已有正确参数（忽略大小写）→ 统一为正确的小写形式 ──
    if (correctLower in lowerToOriginal) {
      const originalKey = lowerToOriginal[correctLower];
      if (originalKey !== correctName) {
        args[correctName] = args[originalKey];
        delete args[originalKey];
        // 更新索引
        delete lowerToOriginal[originalKey.toLowerCase()];
        lowerToOriginal[correctName.toLowerCase()] = correctName;
      }
      continue;
    }

    // ── 2. 正确参数缺失 → 尝试从别名取值 ──
    const aliases = PARAM_ALIASES[correctName];
    if (!aliases) continue;

    for (const alias of aliases) {
      if (alias in lowerToOriginal) {
        const originalKey = lowerToOriginal[alias];
        console.warn(
          `[MCP] 🔄 参数名模糊匹配: 工具 "${definition.function.name}" 的 "${originalKey}" → "${correctName}"`,
        );
        args[correctName] = args[originalKey];
        delete args[originalKey];
        delete lowerToOriginal[alias];
        lowerToOriginal[correctLower] = correctName;
        break;
      }
    }
  }

  return args;
}

class MCPRegistry {
  private tools = new Map<string, ToolExecutor>();

  register(executor: ToolExecutor) {
    this.tools.set(executor.definition.function.name, executor);
  }

  getDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].map(e => e.definition);
  }

  async execute(name: string, argsJson: string, agentId?: string | null, sessionId?: string | null): Promise<{ result: string; isError: boolean }> {
    const executor = this.tools.get(name);
    if (!executor) {
      return { result: `未知工具: ${name}`, isError: true };
    }
    try {
      const rawArgs = JSON.parse(argsJson);
      const args = normalizeArgs(rawArgs, executor.definition);
      const result = await executor.execute(args, agentId, sessionId);
      return { result, isError: false };
    } catch (err) {
      return { result: String(err), isError: true };
    }
  }

  /** 当前已注册工具数量 */
  get size() {
    return this.tools.size;
  }

  /** 获取工具调用列表中每个工具的定义（用于展示） */
  getToolCallInfos(toolCalls: ToolCall[]) {
    return toolCalls.map(tc => ({
      ...tc,
      definition: this.tools.get(tc.name)?.definition,
    }));
  }
}

export const mcpRegistry = new MCPRegistry();
