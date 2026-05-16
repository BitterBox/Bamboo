// ============================================================
// JsonViewer — 交互式 JSON 结构化查看器
//
// 设计参考：Chat.tsx 中工具调用参数的键值对展示方式，
// 将"对话气泡中的工具调用参数渲染"模式推广到任意 JSON。
//
// 功能：
//   - 所有节点默认展开，点击箭头可折叠/展开
//   - 对象类型 → 键值对列表（dt/dd），与 tool call 参数风格一致
//   - 数组类型 → 按索引编号逐项展示
//   - 长字符串 → 默认截断，点击展开/收起
//   - 基本类型 → 内联展示，语法高亮
// ============================================================

import { useState, useCallback } from 'react';
import styles from './JsonViewer.module.css';

/** 超出此长度的字符串默认截断，点击可展开 */
const LONG_STRING_THRESHOLD = 120;

interface JsonViewerProps {
  /** 要展示的 JSON 数据 */
  data: unknown;
}

/**
 * 递归渲染 JSON 节点
 */
function JsonNode({
  keyName,
  value,
}: {
  keyName?: string;
  value: unknown;
}) {
  const [isExpanded, setIsExpanded] = useState(true);
  const toggle = useCallback(() => setIsExpanded((v) => !v), []);

  // ── 基本类型（null / boolean / number / string）───────────
  if (value === null) {
    return (
      <div className={styles.row}>
        {keyName !== undefined && <span className={styles.key}>{keyName}</span>}
        <span className={styles.valueNull}>null</span>
      </div>
    );
  }
  if (typeof value === 'boolean') {
    return (
      <div className={styles.row}>
        {keyName !== undefined && <span className={styles.key}>{keyName}</span>}
        <span className={styles.valueBool}>{value ? 'true' : 'false'}</span>
      </div>
    );
  }
  if (typeof value === 'number') {
    return (
      <div className={styles.row}>
        {keyName !== undefined && <span className={styles.key}>{keyName}</span>}
        <span className={styles.valueNum}>{String(value)}</span>
      </div>
    );
  }
  if (typeof value === 'string') {
    const isLong = value.length > LONG_STRING_THRESHOLD;
    const [isStrExpanded, setIsStrExpanded] = useState(false);
    const toggleStr = useCallback((e: React.MouseEvent) => {
      e.stopPropagation();
      setIsStrExpanded((v) => !v);
    }, []);
    return (
      <div className={styles.row}>
        {keyName !== undefined && <span className={styles.key}>{keyName}</span>}
        {isLong ? (
          <span
            className={`${styles.longStr} ${isStrExpanded ? styles.longStrExpanded : ''}`}
            onClick={toggleStr}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleStr(e as unknown as React.MouseEvent); }}
          >
            {isStrExpanded ? (
              <><span className={styles.strQuotes}>&quot;</span>{renderStringLines(value)}<span className={styles.strQuotes}>&quot;</span> <span className={styles.strToggleHint}>点击收起</span></>
            ) : (
              <><span className={styles.strQuotes}>&quot;</span>{renderStringLines(value.slice(0, LONG_STRING_THRESHOLD))}<span className={styles.strQuotes}>&quot;</span>{value.length > LONG_STRING_THRESHOLD && <>&hellip;</>} <span className={styles.strToggleHint}>点击展开</span></>
            )}
          </span>
        ) : (
          <span className={styles.valueStr}><span className={styles.strQuotes}>&quot;</span>{renderStringLines(value)}<span className={styles.strQuotes}>&quot;</span></span>
        )}
      </div>
    );
  }

  // ── 数组 ─────────────────────────────────────────────────
  if (Array.isArray(value)) {
    // 空数组
    if (value.length === 0) {
      return (
        <div className={styles.row}>
          {keyName !== undefined && <span className={styles.key}>{keyName}</span>}
          <span className={styles.valueType}>[] 空数组</span>
        </div>
      );
    }
    // 简短数组（全部基本类型，长度 ≤ 5）→ 内联展示
    const allPrimitive = value.every(
      (v) => v === null || typeof v !== 'object'
    );
    if (allPrimitive && value.length <= 5) {
      return (
        <div className={styles.row}>
          {keyName !== undefined && <span className={styles.key}>{keyName}</span>}
          <span className={styles.valueInline}>
            [{value.map((v, i) => (
              <JsonValueInline key={i} value={v} />
            )).reduce((acc, item, i) => i === 0 ? [item] : [...acc, <span key={`sep-${i}`} className={styles.sep}>, </span>, item], [] as React.ReactNode[])}
            ]
          </span>
        </div>
      );
    }
    // 复杂数组 → 可折叠
    return (
      <div className={styles.section}>
        <button className={styles.toggle} onClick={toggle}>
          <span className={`${styles.arrow} ${isExpanded ? styles.arrowOpen : ''}`}>›</span>
          {keyName !== undefined && <span className={styles.sectionKey}>{keyName}</span>}
          <span className={styles.sectionMeta}>
            Array[{value.length}]
          </span>
        </button>
        {isExpanded && (
          <div className={styles.children}>
            {value.map((item, i) => (
              <div key={i} className={styles.arrayItem}>
                <span className={styles.arrayIndex}>{i}</span>
                <div className={styles.arrayValue}>
                  <JsonNode
                    value={item}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── 对象 ─────────────────────────────────────────────────
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return (
        <div className={styles.row}>
          {keyName !== undefined && <span className={styles.key}>{keyName}</span>}
          <span className={styles.valueType}>{'{} 空对象'}</span>
        </div>
      );
    }

    // 扁平对象（所有值都是基本类型，且数量 ≤ 8）→ 展开为键值对列表，无折叠按钮
    const allFlat = entries.every(
      ([, v]) => v === null || typeof v !== 'object'
    );
    if (allFlat && entries.length <= 8) {
      return (
        <div className={styles.flatSection}>
          <div className={styles.kvList}>
            {entries.map(([k, v]) => (
              <JsonNode
                key={k}
                keyName={k}
                value={v}
              />
            ))}
          </div>
        </div>
      );
    }

    // 复杂对象 → 可折叠的 section
    return (
      <div className={styles.section}>
        <button className={styles.toggle} onClick={toggle}>
          <span className={`${styles.arrow} ${isExpanded ? styles.arrowOpen : ''}`}>›</span>
          {keyName !== undefined && <span className={styles.sectionKey}>{keyName}</span>}
          <span className={styles.sectionMeta}>{'{'}{entries.length} 项{'}'}</span>
        </button>
        {isExpanded && (
          <div className={styles.kvList}>
            {entries.map(([k, v]) => (
              <JsonNode
                key={k}
                keyName={k}
                value={v}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── 兜底 ─────────────────────────────────────────────────
  return (
    <div className={styles.row}>
      {keyName !== undefined && <span className={styles.key}>{keyName}</span>}
      <span className={styles.valueRaw}>{String(value)}</span>
    </div>
  );
}

/** 将字符串中的 \n 渲染为 <br /> */
function renderStringLines(text: string): React.ReactNode {
  const parts = text.split('\n');
  return parts.reduce((acc, part, i) => {
    if (i === 0) return [part];
    return [...acc, <br key={i} />, part];
  }, [] as React.ReactNode[]);
}

/** 在内联展示时，将字符串中的 \n 替换为可视符号 ↵ */
function inlineString(text: string): string {
  return text.replace(/\n/g, '↵');
}

/** 内联展示一个基本 JSON 值 */
function JsonValueInline({ value }: { value: unknown }) {
  if (value === null) return <span className={styles.valueNull}>null</span>;
  if (typeof value === 'boolean')
    return <span className={styles.valueBool}>{value ? 'true' : 'false'}</span>;
  if (typeof value === 'number')
    return <span className={styles.valueNum}>{String(value)}</span>;
  if (typeof value === 'string')
    return <span className={styles.valueStr}>&quot;{inlineString(value)}&quot;</span>;
  return <span>{JSON.stringify(value)}</span>;
}

/**
 * JsonViewer 组件
 */
export default function JsonViewer({ data }: JsonViewerProps) {
  if (data === undefined || data === null) {
    return <div className={styles.empty}>（空）</div>;
  }

  return (
    <div className={styles.viewer}>
      <JsonNode value={data} />
    </div>
  );
}
