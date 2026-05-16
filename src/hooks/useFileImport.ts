// ============================================================
// useFileImport — 统一管理文件导入
//
// 把原本散落在 Chat.tsx 中的文件选择、拖放、读取、状态
// 收拢到这一个 hook 中，对外只暴露少量接口。
//
// 依赖：
//   - ../utils/fileImport（底层读取 PDF / 文本）
//   - ../services/fileManager（持久化文件副本到 file/ 目录）
//   - 通过 onAddMessage 回调注入 store 操作，保持无副作用依赖
//
// 扩展点：
//   - 导入前校验（大小 / 类型 / 重复）
//   - 导入进度回调
// ============================================================

import { useState, useRef, useCallback } from 'react';
import { importFile } from '../utils/fileImport';
import { saveFile } from '../services/fileManager';

interface UseFileImportOptions {
  /** 当前会话 ID，为空时静默忽略所有操作 */
  sessionId: string | null;
  /** 当前会话标题（用于文件管理索引） */
  sessionTitle: string;
  /** 文件读取完成后如何写入消息，返回新消息 ID */
  onAddMessage: (sessionId: string, msg: { role: 'user'; content: string }) => string;
}

interface UseFileImportReturn {
  /** 挂到 ChatInput 的隐藏 <input type="file"> 上 */
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  /** 拖拽文件悬停状态，用于显示拖放 overlay */
  isDragging: boolean;
  /** 点击导入按钮 → 选择文件 → 读取并 addMessage */
  handleFileImport: (e: React.ChangeEvent<HTMLInputElement>) => void;
  /** 拖放四个事件回调，展开后直接挂到 chatArea 容器上 */
  dragCallbacks: {
    onDragEnter: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
}

export function useFileImport({
  sessionId,
  sessionTitle,
  onAddMessage,
}: UseFileImportOptions): UseFileImportReturn {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** 拖拽进入计数器，处理子元素 enter/leave 误触发 */
  const dragCounterRef = useRef(0);

  /** 单文件最大 50MB */
const MAX_FILE_SIZE = 50 * 1024 * 1024;

/** 计算 SHA-256 哈希（Web Crypto API） */
async function computeHash(arrayBuffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ... (在 useFileImport 函数内)

  /** 读取单个文件并加入当前会话历史（不触发 LLM 请求） */
  const processFile = useCallback(
    async (file: File) => {
      if (!sessionId) return;
      try {
        // 0. 大小限制
        if (file.size > MAX_FILE_SIZE) {
          console.warn(`文件 ${file.name} 超过 50MB 限制，已跳过`);
          return;
        }

        // 1. 读取原始文件为 base64（用于保存到磁盘）
        const arrayBuffer = await file.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let base64 = '';
        for (let i = 0; i < bytes.length; i++) {
          base64 += String.fromCharCode(bytes[i]);
        }
        const contentBase64 = btoa(base64);

        // 2. 计算 SHA-256 哈希（用于去重）
        const hash = await computeHash(arrayBuffer);

        // 3. 读取文本内容（用于消息显示）
        const content = await importFile(file);
        const messageId = onAddMessage(sessionId, { role: 'user', content });

        // 4. 异步保存原始文件副本到 file/ 目录（不阻塞主流程）
        saveFile({
          originalName: file.name,
          contentBase64,
          mimeType: file.type || 'application/octet-stream',
          sessionId,
          sessionTitle,
          messageId,
          hash,
        }).catch((err) => {
          console.error('保存导入文件到磁盘失败:', err);
        });
      } catch (err) {
        console.error('文件导入失败', err);
      }
    },
    [sessionId, sessionTitle, onAddMessage],
  );

  /** 批量处理文件（点击导入 & 拖放共用） */
  const processFiles = useCallback(
    async (files: FileList) => {
      for (let i = 0; i < files.length; i++) {
        await processFile(files[i]);
      }
    },
    [processFile],
  );

  // ── 点击导入 ──────────────────────────────────────────

  const handleFileImport = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      e.target.value = '';
      processFiles(files);
    },
    [processFiles],
  );

  // ── 拖放文件 ──────────────────────────────────────────

  const onDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes('Files')) setIsDragging(true);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) setIsDragging(false);
  }, []);

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsDragging(false);
      processFiles(e.dataTransfer.files);
    },
    [processFiles],
  );

  return {
    fileInputRef,
    isDragging,
    handleFileImport,
    dragCallbacks: {
      onDragEnter,
      onDragOver,
      onDragLeave,
      onDrop,
    },
  };
}