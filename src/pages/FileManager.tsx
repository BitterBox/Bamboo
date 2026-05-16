// ============================================================
// FileManager — 文件管理页面
//
// 展示所有通过"导入文件"按钮导入的文件，按会话分组。
// 支持搜索过滤、内容预览、删除操作。
// ============================================================

import { useState, useEffect, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { listFiles, deleteFile, readFile, type FileEntry } from '../services/fileManager';
import { useChatStore } from '../store/chatStore';
import styles from './FileManager.module.css';

/** 文件图标映射（按扩展名） */
function getFileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'pdf': return '📄';
    case 'csv': return '📊';
    case 'json': return '📋';
    case 'md':
    case 'markdown': return '📝';
    case 'py':
    case 'js':
    case 'ts':
    case 'tsx':
    case 'jsx':
    case 'go':
    case 'rs':
    case 'cpp':
    case 'c':
    case 'java':
    case 'rb':
    case 'sh': return '💻';
    case 'html':
    case 'htm':
    case 'css':
    case 'scss':
    case 'less': return '🌐';
    case 'yaml':
    case 'yml':
    case 'toml':
    case 'ini':
    case 'env': return '⚙️';
    case 'txt':
    case 'log': return '📃';
    default: return '📁';
  }
}

/** 格式化文件大小 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** 相对时间 */
function formatTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins}分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

export default function FileManager() {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [previewFile, setPreviewFile] = useState<{ name: string; content: string } | null>(null);
  const location = useLocation();

  const sessions = useChatStore((s) => s.sessions);

  // 加载文件列表
  useEffect(() => {
    listFiles()
      .then(setFiles)
      .catch(() => setFiles([]))
      .finally(() => setLoading(false));
  }, []);

  // 获取会话标题（优先从 store 实时获取，回退到导入时记录的快照标题）
  const getSessionTitle = (sessionId: string, fallback: string): string => {
    const session = sessions[sessionId];
    return session?.title || fallback || '已删除的会话';
  };

  // 搜索过滤
  const filteredFiles = useMemo(() => {
    if (!search.trim()) return files;
    const q = search.toLowerCase();
    return files.filter((f) =>
      f.originalName.toLowerCase().includes(q) ||
      f.sessionTitle.toLowerCase().includes(q)
    );
  }, [files, search]);

  // 按会话分组
  const groups = useMemo(() => {
    const map = new Map<string, FileEntry[]>();
    for (const f of filteredFiles) {
      const key = f.sessionId;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(f);
    }
    // 每组内按时间倒序
    for (const arr of map.values()) {
      arr.sort((a, b) => b.importedAt - a.importedAt);
    }
    // 组间按最新文件时间倒序
    return [...map.entries()].sort((a, b) =>
      b[1][0].importedAt - a[1][0].importedAt
    );
  }, [filteredFiles]);

  // 不可见时提前退出，避免流式期间后台空转
  if (location.pathname !== '/files') return null;

  const toggleGroup = (id: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleDelete = async (e: React.MouseEvent, file: FileEntry) => {
    e.stopPropagation();
    try {
      await deleteFile(file.filePath);
      setFiles((prev) => prev.filter((f) => f.filePath !== file.filePath));
    } catch {
      // 静默失败
    }
  };

  const handlePreview = async (e: React.MouseEvent, file: FileEntry) => {
    e.stopPropagation();
    try {
      const result = await readFile(file.filePath);
      if (result) {
        setPreviewFile({ name: file.originalName, content: result.content });
      }
    } catch {
      // 静默失败
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>文件管理</h1>
        <p className={styles.subtitle}>
          {files.length > 0
            ? `${files.length} 个已导入文件`
            : '通过对话中的导入按钮添加文件'}
        </p>
      </div>

      {/* ── 搜索 ── */}
      {files.length > 0 && (
        <div className={styles.searchBox}>
          <span className={styles.searchIcon}>🔍</span>
          <input
            className={styles.searchInput}
            type="text"
            placeholder="搜索文件名或会话..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      )}

      {/* ── 列表 ── */}
      {loading ? (
        <div className={styles.empty}>
          <p className={styles.emptyText}>加载中...</p>
        </div>
      ) : groups.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>📂</div>
          <p className={styles.emptyText}>暂无已导入的文件</p>
          <p className={styles.emptyHint}>在对话中点击 📎 按钮或拖放文件即可导入</p>
        </div>
      ) : (
        groups.map(([sessionId, groupFiles]) => {
          const title = getSessionTitle(sessionId, groupFiles[0].sessionTitle);
          const collapsed = collapsedGroups.has(sessionId);
          return (
            <div key={sessionId} className={styles.group}>
              <div
                className={styles.groupHeader}
                onClick={() => toggleGroup(sessionId)}
              >
                <span className={styles.groupTitle}>
                  {title}
                  <span className={styles.groupCount}>({groupFiles.length})</span>
                </span>
                <span className={`${styles.chevron} ${collapsed ? styles.chevronCollapsed : ''}`}>
                  ▼
                </span>
              </div>
              {!collapsed && (
                <div className={styles.fileList}>
                  {groupFiles.map((f) => (
                    <div key={f.filePath} className={styles.fileItem}>
                      <span className={styles.fileIcon}>{getFileIcon(f.originalName)}</span>
                      <div className={styles.fileInfo}>
                        <div className={styles.fileName}>{f.originalName}</div>
                        <div className={styles.fileMeta}>
                          <span>{formatSize(f.size)}</span>
                          <span>{formatTime(f.importedAt)}</span>
                        </div>
                      </div>
                      <div className={styles.fileActions}>
                        <button
                          className={styles.actionBtn}
                          onClick={(e) => handlePreview(e, f)}
                          title="预览"
                        >
                          👁
                        </button>
                        <button
                          className={`${styles.actionBtn} ${styles.deleteBtn}`}
                          onClick={(e) => handleDelete(e, f)}
                          title="删除"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })
      )}

      {/* ── 预览弹窗 ── */}
      {previewFile && (
        <div
          className={styles.previewOverlay}
          onClick={() => setPreviewFile(null)}
        >
          <div
            className={styles.previewModal}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.previewHeader}>
              <span className={styles.previewTitle}>{previewFile.name}</span>
              <button
                className={styles.previewClose}
                onClick={() => setPreviewFile(null)}
              >
                ✕
              </button>
            </div>
            <div className={styles.previewBody}>
              <pre className={styles.previewContent}>{previewFile.content}</pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}