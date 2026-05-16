import { useRef, memo, useState, useCallback } from 'react';
import { useSettingsStore } from '../store/settingsStore';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkCjkFriendly from 'remark-cjk-friendly';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import { renderToString } from 'katex';
import 'katex/dist/katex.min.css';
import styles from './MarkdownContent.module.css';

interface Props {
  content: string;
  /** 是否正在流式接收（用于防止未完成公式闪烂） */
  isStreaming?: boolean;
}

/**
 * 修复1：转义货币符号，防止 $20、$1,000 等被当作 LaTeX 公式
 * 同时修复6：转义后跟中文/日文字符的 $，防止 $中文$ 触发 LaTeX 解析
 * 先保护代码块和已知公式，再转义 $ 特殊模式
 */
function escapeCurrencyDollars(text: string): string {
  const items: string[] = [];
  let result = text.replace(
    /(```[\s\S]*?```|`[^\n`]*`|\$\$[\s\S]*?\$\$|(?<!\\)\$(?!\$)[^$\n]*(?<!\\)\$(?!\$)|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\))/g,
    (match) => { items.push(match); return `\x02${items.length - 1}\x03`; }
  );
  // 转义 $数字 模式（价格等）
  result = result.replace(/\$(\d{1,3}(?:,\d{3})*(?:\.\d+)?[+\-]?)/g, '\\$$1');
  // 修复6：转义后跟 CJK 字符的 $（如 $中文、$长度、$，），防止触发 LaTeX 数学模式
  result = result.replace(/\$([\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\u3000-\u303f\uff00-\uffef，。、；：！？）】])/g, '\\$$1');
  return result.replace(/\x02(\d+)\x03/g, (_, i) => items[Number(i)]);
}

/**
 * 将 \[...\] → $$...$$ 、\(...\) → $...$ 定界符转换
 * 跳过代码块，保持原样
 */
function convertLatexDelimiters(text: string): string {
  return text.replace(
    /(```[\s\S]*?```|`.*?`)|\\\[([\s\S]*?[^\\])\\\]|\\\((.*?)\\\)/g,
    (match, code, sq, rnd) => {
      if (code !== undefined) return code;
      if (sq !== undefined) return `$$${sq}$$`;
      if (rnd !== undefined) return `$${rnd}$`;
      return match;
    }
  );
}

/**
 * 修复2：转义公式中的管道符，防止 $P(A|B)$ 在表格里破坏列分隔
 * 先保护代码块，再将公式内 | 替换为 \vert{}
 */
function escapeLatexPipes(text: string): string {
  const codeBlocks: string[] = [];
  let result = text.replace(/(```[\s\S]*?```|`[^\n`]*`)/g, (match) => {
    codeBlocks.push(match);
    return `\x02${codeBlocks.length - 1}\x03`;
  });
  const escapePipes = (s: string) => s.replace(/(?<!\\)\|/g, '\\vert{}');
  result = result.replace(/\$\$([\s\S]*?)\$\$/g, (_, c) => `$$${escapePipes(c)}$$`);
  result = result.replace(/(?<!\\)\$(?!\$)([^\n$]*)(?<!\\)\$(?!\$)/g, (_, c) => `$${escapePipes(c)}$`);
  return result.replace(/\x02(\d+)\x03/g, (_, i) => codeBlocks[Number(i)]);
}

function preprocessContent(text: string): string {
  // 先转换 LaTeX 定界符：将 \[...\] → $$...$$，\(...\) → $...$
  // 必须在 escapeCurrencyDollars 之前执行，否则 \[...\] 会被占位符保护而无法转换
  let result = convertLatexDelimiters(text);
  result = escapeCurrencyDollars(result);
  result = escapeLatexPipes(result);
  return result;
}

/**
 * 模块级 LRU 缓存：对已完成（非流式）的消息内容缓存预处理结果
 * 切回同一会话时可直接命中，避免对相同文本重复执行三轮正则
 */
const preprocessCache = new Map<string, string>();
const CACHE_MAX = 100;

function getCachedPreprocess(text: string): string {
  const cached = preprocessCache.get(text);
  if (cached !== undefined) return cached;
  const result = preprocessContent(text);
  if (preprocessCache.size >= CACHE_MAX) {
    // 淘汰最早插入的条目（Map 按插入顺序迭代）
    preprocessCache.delete(preprocessCache.keys().next().value!);
  }
  preprocessCache.set(text, result);
  return result;
}

/**
 * 快速预检：文本是否可能包含 LaTeX 语法
 * 99% 的流式文本不含 $ 和 \，由此跳过后续的 KaTeX 渲染检查
 */
function hasAnyLatexSyntax(text: string): boolean {
  return text.includes('$') || text.includes('\\');
}

/**
 * 修复3：检测最后一个块公式是否可渲染
 * 流式接收时，若公式尚未写完（如 $$\sum_{i=1）会抛出 KaTeX 错误
 * 此函数返回 false 时，调用方回退到上一帧安全内容
 *
 * 优化要点：
 *   1. 快速预检：无 $/\ 的直接返回 true，避免 renderToString 开销
 *   2. 仅检查 $$ 块公式（\[...\] 已由 preprocessContent 标准化为 $$）
 *   3. 公式必须含 \ 才认为是真公式（如 \sum、\frac），避免误判含 $$ 的普通文本
 */
function isLastFormulaRenderable(text: string): boolean {
  // 快速路径：文本不含 $ 和 \ → 不可能有公式
  if (!hasAnyLatexSyntax(text)) return true;

  // 检测 $$ 定界符配对情况
  if ((text.match(/\$\$/g) ?? []).length % 2 === 1) {
    const formula = text.match(/\$\$([\s\S]*)$/)?.[1] ?? '';
    if (!formula) return true;

    // 不含反斜杠 → 不是真正的 LaTeX 公式（可能是价格 $20、变量 $foo 等）
    if (!formula.includes('\\')) return true;

    try {
      renderToString(formula, { displayMode: true, throwOnError: true });
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

function CodeBlock({ children }: { children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const contentRef = useRef('');

  // 函数式内容获取：延迟求值，避免每次渲染都提取文本
  const getContent = useCallback(() => contentRef.current, []);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(getContent()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [getContent]);

  // 提取并缓存文本内容
  const extractContent = useCallback((node: HTMLPreElement | null) => {
    if (node) contentRef.current = node.textContent ?? '';
  }, []);

  return (
    <div className={styles.codeWrapper}>
      <pre ref={extractContent}>{children}</pre>
      <button
        className={`${styles.copyBtn}${copied ? ` ${styles.copyBtnCopied}` : ''}`}
        onClick={handleCopy}
        aria-label={copied ? '已复制' : '复制代码'}
      >
        {copied ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>
    </div>
  );
}

function MarkdownContent({ content, isStreaming }: Props) {
  const { appConfig } = useSettingsStore();
  // 修复3：记录最近一次可安全渲染的内容，流式过程中公式未完成时回退
  const validContentRef = useRef(content);

  // 当 content 变化时同步更新 ref（非流式状态下）
  if (!isStreaming) {
    validContentRef.current = content;
  }

  // ── 流式节流：避免每 20ms 对全文重做 3 轮正则 + ReactMarkdown 解析 ──
  // 流式期间 content 每帧都在变（"你"→"你好"→"你好，"…），
  // 预处理缓存永远 miss，导致 O(n²) 的 regex 开销。
  // 节流策略：累积 ≥20 字或距上次渲染 ≥50ms 才更新 effective，
  // 其余帧复用上一帧的预处理结果，将复杂度降为 O(n)。
  const throttleRef = useRef({ flushed: content, time: 0 });
  let effective: string;
  if (isStreaming) {
    const now = performance.now();
    const charDelta = content.length - throttleRef.current.flushed.length;
    const elapsed = now - throttleRef.current.time;
    if (charDelta >= 20 || elapsed >= 50) {
      throttleRef.current = { flushed: content, time: now };
    }
    effective = throttleRef.current.flushed;
  } else {
    effective = content;
    throttleRef.current.flushed = content; // 流式结束后重置，确保最终内容被渲染
  }

  // 流式过程中内容逐帧变化，不写入缓存（避免污染）；完成后命中缓存免重算
  let processed = isStreaming ? preprocessContent(effective) : getCachedPreprocess(effective);

  if (isStreaming) {
    if (isLastFormulaRenderable(processed)) {
      validContentRef.current = processed;
    } else {
      processed = validContentRef.current;
    }
  }

  return (
    <div className={styles.markdown} style={{ '--p-spacing': `${appConfig.paragraphSpacing}em` } as React.CSSProperties}>
      <ReactMarkdown
        // 修复4：remarkCjkFriendly 防止中文换行处多出空格
        // 修复5：关闭 singleTilde 防止 ~30~50、~估计~ 等被误渲染为删除线
        remarkPlugins={[remarkCjkFriendly, [remarkGfm, { singleTilde: false }], remarkMath]}
        rehypePlugins={[rehypeRaw, [rehypeKatex, { strict: false, throwOnError: false }]]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          // 将 rehype-raw 透传的非标准 HTML 标签（如 AI 回复中提到的 <filemanager>）
          // 渲染为无害的 <span>，避免 React 19 的 "unrecognized tag" 警告
          filemanager: ({ children }) => <span>{children}</span>,
        }}
      >
        {processed}
      </ReactMarkdown>
    </div>
  );
}

// 性能优化：使用 memo 避免不必要的重渲染
export default memo(MarkdownContent, (prevProps, nextProps) => {
  // 只有 content 或 isStreaming 变化时才重新渲染
  return prevProps.content === nextProps.content && prevProps.isStreaming === nextProps.isStreaming;
});
