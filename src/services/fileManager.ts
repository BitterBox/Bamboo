// ============================================================
// fileManager — 文件管理服务
//
// 封装 Electron IPC 调用，浏览器环境降级到 localStorage。
//
// 职责：
//   - 保存导入文件（→ Electron file-save IPC）
//   - 列出所有文件（→ Electron file-list IPC）
//   - 删除文件（→ Electron file-delete IPC）
//   - 读取文件内容（→ Electron file-read IPC）
// ============================================================

import type { ImportedFileMeta } from '../types';

/** 文件条目类型（公开导出，供 FileManager 使用） */
export type FileEntry = ImportedFileMeta;

// ── 浏览器降级存储 key ───────────────────────────────────
const BROWSER_KEY = 'llm-chat-imported-files';

function browserLoad(): ImportedFileMeta[] {
  try {
    const raw = localStorage.getItem(BROWSER_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function browserSave(files: ImportedFileMeta[]) {
  localStorage.setItem(BROWSER_KEY, JSON.stringify(files));
}

// ── 公开 API ─────────────────────────────────────────────

export interface FileSaveInput {
  originalName: string;
  /** 文件内容，base64 编码的二进制数据 */
  contentBase64: string;
  mimeType: string;
  sessionId: string;
  sessionTitle: string;
  messageId: string;
  /** SHA-256 内容哈希（用于去重） */
  hash?: string;
}

/**
 * 保存导入文件：Electron → IPC 写入磁盘；浏览器 → localStorage
 */
export async function saveFile(input: FileSaveInput): Promise<string | null> {
  if (window.electronAPI) {
    const res = await window.electronAPI.fileSave(input);
    if (res.error) {
      console.error('[fileManager] saveFile failed:', res.error);
      return null;
    }
    return res.filePath ?? null;
  }

  // 浏览器降级
  const files = browserLoad();
  // base64 解码后的大小 ≈ (base64长度 * 3 / 4)
  const estimatedSize = Math.ceil((input.contentBase64.length * 3) / 4);
  const record: ImportedFileMeta = {
    filePath: `${Date.now()}_${input.sessionId.slice(0, 6)}_${input.originalName}`,
    originalName: input.originalName,
    size: estimatedSize,
    mimeType: input.mimeType,
    sessionId: input.sessionId,
    sessionTitle: input.sessionTitle,
    messageId: input.messageId,
    importedAt: Date.now(),
  };
  files.push(record);
  browserSave(files);
  return record.filePath;
}

/**
 * 列出所有已导入文件
 */
export async function listFiles(): Promise<ImportedFileMeta[]> {
  if (window.electronAPI) {
    const res = await window.electronAPI.fileList();
    if (res.error) {
      console.error('[fileManager] listFiles failed:', res.error);
      return [];
    }
    return res.files as ImportedFileMeta[];
  }

  return browserLoad();
}

/**
 * 删除文件
 */
export async function deleteFile(filePath: string): Promise<boolean> {
  if (window.electronAPI) {
    const res = await window.electronAPI.fileDelete(filePath);
    if (res.error) {
      console.error('[fileManager] deleteFile failed:', res.error);
      return false;
    }
    return true;
  }

  const files = browserLoad().filter((f) => f.filePath !== filePath);
  browserSave(files);
  return true;
}

/**
 * 读取文件内容（用于预览）
 * 返回 { content, isBinary }：
 *   - 文本文件：content 为 utf-8 字符串，isBinary=false
 *   - 二进制文件：content 为占位提示，isBinary=true
 */
export async function readFile(filePath: string): Promise<{ content: string; isBinary: boolean } | null> {
  if (window.electronAPI) {
    const res = await window.electronAPI.fileRead(filePath);
    if (res.error) {
      console.error('[fileManager] readFile failed:', res.error);
      return null;
    }
    if (res.encoding === 'base64') {
      return { content: '(二进制文件，无法预览。文件已原样保存在磁盘上)', isBinary: true };
    }
    return { content: res.content ?? '', isBinary: false };
  }

  // 浏览器降级
  return { content: '(浏览器环境无法预览文件内容)', isBinary: true };
}