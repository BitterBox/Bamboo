// ============================================================
// useKeyboardShortcuts — 全局键盘快捷键 Hook
// 监听 document 的 keydown 事件，按配置分发到对应回调
//
// 设计要点：
//   - 输入框内（INPUT/TEXTAREA/contentEditable）自动屏蔽，
//     防止与正常文字输入冲突
//   - 绑定格式：单键 "e"、功能键 "F2"、组合键 "Ctrl+Shift+K"
//   - useCallback 包裹 handler，避免每次渲染都重新注册事件监听
//
// 扩展指南：
//   - 新增操作：在 ShortcutCallbacks 添加回调、在 actionMap 添加映射
//   - 作用域隔离：传入 containerRef 替换 document，限制快捷键生效范围
//   - 冲突检测：在注册时校验新绑定是否与已有绑定重叠
// ============================================================

import { useEffect, useCallback } from 'react';
import type { ShortcutConfig, ShortcutAction } from '../types';

/** 快捷键触发时的回调集合，与 ShortcutAction 一一对应 */
export interface ShortcutCallbacks {
  onEdit: () => void;
  onDelete: () => void;
  onRetry: () => void;
  onContinueFrom: () => void;
  onCopy: () => void;
  onClearConversation: () => void;
}

/**
 * 判断键盘事件是否匹配单个绑定字符串
 *
 * 绑定格式（大小写敏感）：
 *   "e"          → 单独按 E 键（无任何修饰键）
 *   "F2"         → 功能键 F2
 *   "Ctrl+K"     → Ctrl + K
 *   "Ctrl+Shift+K" → Ctrl + Shift + K
 *
 * @param e       原生键盘事件
 * @param binding 绑定字符串
 */
function matchesBinding(e: KeyboardEvent, binding: string): boolean {
  const parts = binding.split('+');
  // 最后一个 part 是主键，前面的都是修饰键
  const key = parts[parts.length - 1];
  const ctrl = parts.includes('Ctrl');
  const shift = parts.includes('Shift');
  const alt = parts.includes('Alt');
  const meta = parts.includes('Meta');

  // 主键匹配：同时检查 e.key（字符值）和 e.code 推导键名（物理键位）
  // macOS 上 Option+t → e.key='†' 但 e.code='KeyT'，仅靠 e.key 会匹配失败
  const eKey = e.key.toLowerCase();
  const eCodeKey = e.code.startsWith('Key')
    ? e.code.slice(3).toLowerCase()       // KeyT → t
    : e.code.startsWith('Digit')
      ? e.code.slice(5)                    // Digit1 → 1
      : '';                                // 非字母/数字键只依赖 e.key
  const keyLower = key.toLowerCase();
  const keyMatches = eKey === keyLower || eCodeKey === keyLower;

  return (
    keyMatches &&
    e.ctrlKey === ctrl &&
    e.shiftKey === shift &&
    e.altKey === alt &&
    e.metaKey === meta
  );
}

/**
 * 找出匹配当前键盘事件的第一个绑定字符串，未匹配则返回 null
 *
 * @param e        原生键盘事件
 * @param bindings 该操作的所有有效绑定列表
 */
function findMatchingBinding(e: KeyboardEvent, bindings: string[]): string | null {
  return bindings.find((b) => matchesBinding(e, b)) ?? null;
}

/**
 * 判断一个绑定在输入框内是否可以安全触发（不会干扰正常文字输入）
 *
 * 安全条件：
 *   - 含 Ctrl / Alt / Meta 修饰键（如 Ctrl+Shift+K）
 *   - 功能键 F1–F12（如 F2）
 *
 * 不安全（会与输入冲突）：
 *   - 纯字母/数字键（如 e、r、t）
 *   - Delete / Backspace 等有默认行为的键
 *   - 仅带 Shift 的组合（如 Shift+R）
 */
function isSafeInInput(binding: string): boolean {
  const parts = binding.split('+');
  if (parts.includes('Ctrl') || parts.includes('Alt') || parts.includes('Meta')) return true;
  const key = parts[parts.length - 1];
  return /^F\d+$/.test(key);
}

/**
 * 注册全局键盘快捷键
 *
 * @param config    当前快捷键配置（来自 settingsStore）
 * @param callbacks 各操作对应的回调函数
 */
export function useKeyboardShortcuts(
  config: ShortcutConfig,
  callbacks: ShortcutCallbacks
): void {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // IME 组合输入期间忽略快捷键
      if (e.isComposing) return;

      const target = e.target as HTMLElement;
      const inInput =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable;

      // 操作映射表：action 名称 → 对应回调
      // 扩展：新增操作时在此数组末尾追加一项即可
      const actionMap: [ShortcutAction, () => void][] = [
        ['editMessage',       callbacks.onEdit],
        ['deleteMessage',     callbacks.onDelete],
        ['retryMessage',      callbacks.onRetry],
        ['continueFrom',      callbacks.onContinueFrom],
        ['copyMessage',       callbacks.onCopy],
        ['clearConversation', callbacks.onClearConversation],
      ];

      // 按顺序检查，命中后 preventDefault 并立即 return（防止多操作同时触发）
      // 焦点在输入框内时，只允许"安全"绑定（含 Ctrl/Alt/Meta 或功能键）触发
      for (const [action, cb] of actionMap) {
        const matched = findMatchingBinding(e, config[action]);
        if (matched === null) continue;
        if (inInput && !isSafeInInput(matched)) continue;
        e.preventDefault();
        cb();
        return;
      }
    },
    [config, callbacks]
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}
