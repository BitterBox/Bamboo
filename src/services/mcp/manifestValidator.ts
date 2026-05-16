// src/services/mcp/manifestValidator.ts
// 工具清单校验器：在加载时检查 JSON 的合法性

import type { ToolManifest } from './manifestTypes';

export interface ValidationError {
  tool: string;
  field: string;
  message: string;
}

/**
 * 校验单个工具清单，返回错误列表（空数组 = 通过）
 */
export function validateManifest(manifest: unknown, fileName: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const m = manifest as Record<string, unknown>;

  if (!m || typeof m !== 'object') {
    return [{ tool: fileName, field: '(root)', message: '清单必须是 JSON 对象' }];
  }

  // ── 必填字段 ──
  if (!m.name || typeof m.name !== 'string') {
    errors.push({ tool: fileName, field: 'name', message: '缺少必填字段 name（工具名称）' });
  }
  if (!m.version || typeof m.version !== 'string') {
    errors.push({ tool: fileName, field: 'version', message: '缺少必填字段 version（版本号）' });
  }
  if (!m.type || (m.type !== 'builtin' && m.type !== 'user')) {
    errors.push({ tool: fileName, field: 'type', message: 'type 必须是 "builtin" 或 "user"' });
  }

  // ── function 定义 ──
  const func = m.function as Record<string, unknown> | undefined;
  if (!func || typeof func !== 'object') {
    errors.push({ tool: fileName, field: 'function', message: '缺少必填字段 function（LLM 可见的函数定义）' });
  } else {
    if (!func.description || typeof func.description !== 'string') {
      errors.push({ tool: fileName, field: 'function.description', message: '缺少必填字段 description（工具描述）' });
    }
    if (!func.parameters || typeof func.parameters !== 'object') {
      errors.push({ tool: fileName, field: 'function.parameters', message: '缺少必填字段 parameters（参数 JSON Schema）' });
    } else {
      const params = func.parameters as Record<string, unknown>;
      if (params.type !== 'object') {
        errors.push({ tool: fileName, field: 'function.parameters.type', message: 'parameters.type 必须是 "object"' });
      }
      // 检查 properties 中的参数类型是否合法
      if (params.properties && typeof params.properties === 'object') {
        for (const [propName, propSchema] of Object.entries(params.properties)) {
          const ps = propSchema as Record<string, unknown>;
          if (!ps.type) {
            errors.push({ tool: fileName, field: `function.parameters.properties.${propName}`, message: `参数 "${propName}" 缺少 type 字段` });
          } else if (!['string', 'number', 'boolean', 'object', 'array'].includes(ps.type as string)) {
            errors.push({ tool: fileName, field: `function.parameters.properties.${propName}`, message: `参数 "${propName}" 的 type "${ps.type}" 不合法（允许: string/number/boolean/object/array）` });
          }
        }
      }
      // 检查 required 数组中的参数是否都在 properties 中定义
      if (Array.isArray(params.required) && params.properties) {
        for (const req of params.required) {
          if (typeof req === 'string' && !(req in (params.properties as object))) {
            errors.push({ tool: fileName, field: 'function.parameters.required', message: `required 中的 "${req}" 未在 properties 中定义` });
          }
        }
      }
    }
  }

  // ── executor ──
  if (!m.executor) {
    errors.push({ tool: fileName, field: 'executor', message: '缺少必填字段 executor' });
  } else if (typeof m.executor === 'string') {
    if (!m.executor.startsWith('builtin:')) {
      errors.push({ tool: fileName, field: 'executor', message: `字符串 executor 必须以 "builtin:" 开头，当前值: "${m.executor}"` });
    }
  } else if (typeof m.executor === 'object') {
    const exec = m.executor as Record<string, unknown>;
    if (!exec.type || (exec.type !== 'http' && exec.type !== 'shell')) {
      errors.push({ tool: fileName, field: 'executor.type', message: `executor.type 必须是 "http" 或 "shell"，当前值: "${exec.type}"` });
    }
    if (exec.type === 'http' && !exec.config) {
      errors.push({ tool: fileName, field: 'executor.config', message: 'HTTP 执行器需要 config 字段' });
    }
    if (exec.type === 'shell' && !exec.config) {
      errors.push({ tool: fileName, field: 'executor.config', message: 'Shell 执行器需要 config 字段' });
    }
  } else {
    errors.push({ tool: fileName, field: 'executor', message: 'executor 必须是字符串（"builtin:xxx"）或对象（{type, config}）' });
  }

  // ── permissions ──
  if (!Array.isArray(m.permissions)) {
    errors.push({ tool: fileName, field: 'permissions', message: 'permissions 必须是字符串数组' });
  } else {
    const validPerms = ['allowRead', 'allowWrite', 'pathInAllowedDirs', 'pythonToolEnabled', 'webToolEnabled', 'commitDirInAllowedDirs'];
    for (const p of m.permissions) {
      if (typeof p === 'string' && !validPerms.includes(p)) {
        errors.push({ tool: fileName, field: 'permissions', message: `未知权限 "${p}"（允许: ${validPerms.join(', ')}）` });
      }
    }
  }

  // ── category（可选）──
  if (m.category !== undefined) {
    const validCategories = ['file', 'code', 'python', 'web', 'custom'];
    if (!validCategories.includes(m.category as string)) {
      errors.push({ tool: fileName, field: 'category', message: `category 必须是 ${validCategories.join(' / ')} 之一，当前值: "${m.category}"` });
    }
  }

  return errors;
}

/**
 * 批量校验，返回第一个错误的摘要或成功信息
 */
export function validateManifests(manifests: unknown[], source: string): { valid: number; errors: ValidationError[] } {
  const allErrors: ValidationError[] = [];
  let valid = 0;

  for (const m of manifests) {
    const name = (m as Record<string, unknown>)?.name || '(unknown)';
    const errors = validateManifest(m, typeof name === 'string' ? name : '(unknown)');
    if (errors.length === 0) {
      valid++;
    } else {
      allErrors.push(...errors);
    }
  }

  if (allErrors.length > 0) {
    console.warn(`[manifestValidator] ${source}：${valid} 个通过，${allErrors.length} 个错误`);
    for (const e of allErrors.slice(0, 10)) {
      console.warn(`  - ${e.tool}: ${e.field} → ${e.message}`);
    }
    if (allErrors.length > 10) {
      console.warn(`  ... 还有 ${allErrors.length - 10} 个错误`);
    }
  }

  return { valid, errors: allErrors };
}