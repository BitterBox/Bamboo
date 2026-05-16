import Modal from '../Modal';
import { ChevronIcon, EditIcon } from '../icons';
import type { Role, MCPConfig } from '../../types';
import { useState, useCallback } from 'react';
import styles from '../../pages/Chat.module.css';

interface RightPanelProps {
  isCollapsed: boolean;
  width: number;
  role?: Role;
  activeSystemPrompt: string;
  effectiveMcpConfig: MCPConfig;
  appConfig: { fontSize: number; lineHeight: number };
  currentSessionId: string | null;
  editingPrompt: boolean;
  editPromptContent: string;
  editingMCPTool: string | null;
  isPromptExpanded: boolean;
  shouldTruncatePrompt: boolean;
  promptContentRef: React.RefObject<HTMLDivElement | null>;
  onToggleCollapse: () => void;
  onResize: (e: React.MouseEvent<HTMLDivElement>) => void;
  onOpenPromptEdit: () => void;
  onClosePromptEdit: () => void;
  onEditPromptContentChange: (value: string) => void;
  onSavePrompt: () => void;
  onTogglePromptExpand: () => void;
  onOpenMCPToolEdit: (tool: string) => void;
  onCloseMCPToolEdit: () => void;
  onUpdateMcpConfig: (config: MCPConfig) => void;
  onQuickPhraseClick: (text: string) => void;
  onSelectFolder?: () => Promise<string | null>;
}

export default function RightPanel({
  isCollapsed,
  width,
  role,
  activeSystemPrompt,
  effectiveMcpConfig,
  appConfig,
  currentSessionId,
  editingPrompt,
  editPromptContent,
  editingMCPTool,
  isPromptExpanded,
  shouldTruncatePrompt,
  promptContentRef,
  onToggleCollapse,
  onResize,
  onOpenPromptEdit,
  onClosePromptEdit,
  onEditPromptContentChange,
  onSavePrompt,
  onTogglePromptExpand,
  onOpenMCPToolEdit,
  onCloseMCPToolEdit,
  onUpdateMcpConfig,
  onQuickPhraseClick,
  onSelectFolder,
}: RightPanelProps) {
  const [condaEnvs, setCondaEnvs] = useState<string[]>([]);
  const [condaLoading, setCondaLoading] = useState(false);

  const refreshCondaEnvs = useCallback(async () => {
    setCondaLoading(true);
    try {
      if (window.electronAPI) {
        const result = await window.electronAPI.mcpListCondaEnvs();
        if (result.envs) setCondaEnvs(result.envs);
      }
    } catch {
      // 忽略错误
    } finally {
      setCondaLoading(false);
    }
  }, []);

  // 弹窗打开时自动加载 Conda 环境列表
  const handleOpenPythonEdit = useCallback(() => {
    onOpenMCPToolEdit('python');
    refreshCondaEnvs();
  }, [onOpenMCPToolEdit, refreshCondaEnvs]);

  return (
    <>
      {/* 文件工具配置弹窗 */}
      <Modal
        open={editingMCPTool === 'file'}
        onClose={onCloseMCPToolEdit}
        title="配置 · 文件工具"
        maxWidth="480px"
        footer={
          <button className={styles.promptEditSave} onClick={onCloseMCPToolEdit}>完成</button>
        }
      >
        <label className={styles.mcpPermRow}>
          <input
            type="checkbox"
            checked={effectiveMcpConfig.allowRead}
            onChange={(e) => {
              onUpdateMcpConfig({ ...effectiveMcpConfig, allowRead: e.target.checked });
            }}
          />
          允许读取文件 / 目录
        </label>
        <label className={styles.mcpPermRow}>
          <input
            type="checkbox"
            checked={effectiveMcpConfig.allowWrite}
            onChange={(e) => {
              onUpdateMcpConfig({ ...effectiveMcpConfig, allowWrite: e.target.checked });
            }}
          />
          允许写入文件
        </label>

        <div className={styles.mcpDirSection}>
          <div className={styles.mcpDirSectionLabel}>允许访问的目录</div>
          {effectiveMcpConfig.allowedDirs.length === 0 && (
            <div className={styles.mcpHint}>
              {window.electronAPI ? '未添加目录，所有路径均被拒绝访问' : '仅桌面端可配置目录'}
            </div>
          )}
          {effectiveMcpConfig.allowedDirs.length > 0 && (
            <div className={styles.mcpDirList}>
              {effectiveMcpConfig.allowedDirs.map((dir, i) => (
                <div key={i} className={styles.mcpDirItem}>
                  <span className={styles.mcpDirItemPath} title={dir}>{dir}</span>
                  <button
                    className={styles.mcpDirRemoveBtn}
                    onClick={() => {
                      onUpdateMcpConfig({
                        ...effectiveMcpConfig,
                        allowedDirs: effectiveMcpConfig.allowedDirs.filter((_, idx) => idx !== i),
                      });
                    }}
                    title="移除"
                  >✕</button>
                </div>
              ))}
            </div>
          )}
          {window.electronAPI && (
            <button
              className={styles.mcpAddDirBtn}
              onClick={async () => {
                if (!onSelectFolder) return;
                const folder = await onSelectFolder();
                if (folder) {
                  onUpdateMcpConfig({
                    ...effectiveMcpConfig,
                    allowedDirs: [...effectiveMcpConfig.allowedDirs, folder],
                  });
                }
              }}
            >
              + 添加目录
            </button>
          )}
        </div>
      </Modal>

      {/* 代码工具配置弹窗 */}
      <Modal
        open={editingMCPTool === 'code'}
        onClose={onCloseMCPToolEdit}
        title="配置 · 代码工具"
        maxWidth="480px"
        footer={
          <button className={styles.promptEditSave} onClick={onCloseMCPToolEdit}>完成</button>
        }
      >
        <div style={{ fontSize: '0.875rem', color: '#374151', lineHeight: 1.6 }}>
          <p style={{ marginBottom: '0.75rem' }}>代码工具与文件工具共享相同的读写权限和目录限制配置。</p>
          <p style={{ marginBottom: '0.5rem', fontWeight: 500 }}>包含以下工具：</p>
          <ul style={{ margin: 0, paddingLeft: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <li><code style={{ fontSize: '0.8125rem' }}>analyze_code</code> — 分析代码结构（需读权限）</li>
            <li><code style={{ fontSize: '0.8125rem' }}>search</code> — 搜索文本/符号或文件名在项目中的位置（需读权限）</li>
            <li><code style={{ fontSize: '0.8125rem' }}>suggest_refactorings</code> — 给出重构建议（需读权限）</li>
            <li><code style={{ fontSize: '0.8125rem' }}>modify_code</code> — 精确替换代码片段（需写权限）</li>
          </ul>
          <p style={{ marginTop: '0.75rem', color: '#6b7280', fontSize: '0.8125rem' }}>
            如需调整目录限制或读写权限，请在"文件工具"中配置。
          </p>
          {!window.electronAPI && (
            <p style={{ marginTop: '0.5rem', color: '#dc2626', fontSize: '0.8125rem' }}>
              ⚠️ 代码工具仅在桌面端（Electron）可用。
            </p>
          )}
        </div>
      </Modal>

      {/* Python 工具配置弹窗 */}
      <Modal
        open={editingMCPTool === 'python'}
        onClose={onCloseMCPToolEdit}
        title="配置 · Python 工具"
        maxWidth="480px"
        footer={
          <button className={styles.promptEditSave} onClick={onCloseMCPToolEdit}>完成</button>
        }
      >
        <div style={{ fontSize: '0.875rem', color: '#374151', lineHeight: 1.6 }}>
          <p style={{ marginBottom: '0.75rem' }}>
            设置默认的 Conda 环境。LLM 调用 <code style={{ fontSize: '0.8125rem', background: '#f3f4f6', padding: '1px 4px', borderRadius: '4px' }}>run_python</code> 时可随时通过 <code style={{ fontSize: '0.8125rem' }}>env_name</code> 参数覆盖此值。
          </p>

          <div style={{ marginBottom: '0.75rem' }}>
            <label style={{ display: 'block', fontWeight: 500, marginBottom: '0.25rem' }}>
              默认 Conda 环境
            </label>
            <div style={{ display: 'flex', gap: '6px' }}>
              <input
                type="text"
                list="conda-env-list"
                style={{
                  flex: 1,
                  padding: '6px 10px',
                  border: '1px solid #d1d5db',
                  borderRadius: '6px',
                  fontSize: '0.875rem',
                  boxSizing: 'border-box',
                }}
                placeholder='如 "py310"、"data-science"（留空则使用系统 Python）'
                value={effectiveMcpConfig.condaEnv || ''}
                onChange={(e) => {
                  onUpdateMcpConfig({ ...effectiveMcpConfig, condaEnv: e.target.value });
                }}
              />
              <datalist id="conda-env-list">
                {condaEnvs.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
              <button
                type="button"
                onClick={refreshCondaEnvs}
                disabled={condaLoading}
                title="扫描已安装的 Conda 环境"
                style={{
                  padding: '6px 12px',
                  border: '1px solid #d1d5db',
                  borderRadius: '6px',
                  background: '#f9fafb',
                  cursor: condaLoading ? 'not-allowed' : 'pointer',
                  fontSize: '0.875rem',
                  whiteSpace: 'nowrap',
                  opacity: condaLoading ? 0.6 : 1,
                }}
              >
                {condaLoading ? '⏳' : '🔄'} 扫描
              </button>
            </div>
            {condaEnvs.length > 0 && (
              <div style={{ marginTop: '4px', fontSize: '0.75rem', color: '#6b7280' }}>
                已检测到 {condaEnvs.length} 个环境：{condaEnvs.slice(0, 8).join('、')}{condaEnvs.length > 8 ? '…' : ''}
              </div>
            )}
          </div>

          <p style={{ marginBottom: '0.5rem', fontWeight: 500 }}>环境检测策略（4 层降级）：</p>
          <ol style={{ margin: 0, paddingLeft: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.8125rem', color: '#6b7280' }}>
            <li><code style={{ fontSize: '0.75rem' }}>CONDA_PREFIX</code> 环境变量</li>
            <li><code style={{ fontSize: '0.75rem' }}>CONDA_HOME</code> 环境变量</li>
            <li><code style={{ fontSize: '0.75rem' }}>conda info --json</code> 命令自动扫描</li>
            <li>常见安装路径（~/anaconda3、~/miniconda3、C:\Anaconda3 等）</li>
          </ol>

          <div style={{ marginTop: '0.75rem', padding: '0.5rem 0.75rem', background: '#f0f9ff', borderRadius: '6px', fontSize: '0.8125rem', color: '#1e40af', border: '1px solid #bfdbfe' }}>
            💡 外部包（如 pandas、numpy）需要手动在目标 Conda 环境中安装：<br />
            <code style={{ fontSize: '0.75rem', background: '#dbeafe', padding: '1px 6px', borderRadius: '4px', marginTop: '4px', display: 'inline-block' }}>
              conda activate your-env &amp;&amp; pip install pandas numpy
            </code>
          </div>

          {!window.electronAPI && (
            <p style={{ marginTop: '0.5rem', color: '#dc2626', fontSize: '0.8125rem' }}>
              ⚠️ Python 工具仅在桌面端（Electron）可用。
            </p>
          )}
        </div>
      </Modal>

      {/* Web 工具配置弹窗 */}
      <Modal
        open={editingMCPTool === 'web'}
        onClose={onCloseMCPToolEdit}
        title="配置 · Web 工具"
        maxWidth="480px"
        footer={
          <button className={styles.promptEditSave} onClick={onCloseMCPToolEdit}>完成</button>
        }
      >
        <div style={{ fontSize: '0.875rem', color: '#374151', lineHeight: 1.6 }}>
          <p style={{ marginBottom: '0.75rem' }}>
            Web 工具使用读取权限访问互联网资源。无需配置目录限制（URL 不适用文件目录白名单）。
          </p>
          <p style={{ marginBottom: '0.5rem', fontWeight: 500 }}>包含以下工具：</p>
          <ul style={{ margin: 0, paddingLeft: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <li><code style={{ fontSize: '0.8125rem' }}>fetch_url</code> — 访问 http/https URL，获取网页/网络文件内容（需读权限）</li>
          </ul>
          <p style={{ marginTop: '0.75rem', color: '#6b7280', fontSize: '0.8125rem' }}>
            安全限制：仅允许 GET 请求，禁止访问内网地址（localhost / 局域网），默认超时 30s（上限 60s），响应大小默认 500KB（上限 5MB），最多跟随 5 次重定向。
          </p>
          <p style={{ marginTop: '0.5rem', color: '#6b7280', fontSize: '0.8125rem' }}>
            如需调整读取权限，请在"文件工具"中配置。
          </p>
          {!window.electronAPI && (
            <p style={{ marginTop: '0.5rem', color: '#dc2626', fontSize: '0.8125rem' }}>
              ⚠️ Web 工具仅在桌面端（Electron）可用。
            </p>
          )}
        </div>
      </Modal>

      {/* 智能体提示词编辑弹窗 */}
      {role && (
        <Modal
          open={editingPrompt}
          onClose={onClosePromptEdit}
          title="编辑智能体提示词"
          footer={
            <>
              <button className={styles.promptEditCancel} onClick={onClosePromptEdit}>取消</button>
              <button className={styles.promptEditSave} onClick={onSavePrompt}>保存</button>
            </>
          }
        >
          <div className={styles.promptEditField}>
            <label>智能体名称</label>
            <div className={styles.promptEditRoleName}>{role.name}</div>
          </div>
          <div className={styles.promptEditField}>
            <label>系统提示词</label>
            <textarea
              className={styles.promptEditTextarea}
              value={editPromptContent}
              onChange={(e) => onEditPromptContentChange(e.target.value)}
              placeholder="输入系统提示词..."
              rows={10}
            />
          </div>
        </Modal>
      )}

      {/* 右侧面板主体 */}
      <div
        className={`${styles.rightPanel} ${isCollapsed ? styles.collapsed : ''}`}
        style={isCollapsed ? undefined : { width }}
      >
        <div className={styles.leftHandle} onMouseDown={onResize}>
          <div
            className={styles.collapseHoverZone}
            onMouseDown={(e) => e.stopPropagation()}
          />
          <button
            className={styles.collapseToggle}
            onClick={onToggleCollapse}
            onMouseDown={(e) => e.stopPropagation()}
            title={isCollapsed ? '展开侧边栏' : '折叠侧边栏'}
          >
            <ChevronIcon direction={isCollapsed ? 'left' : 'right'} size={14} strokeWidth={2.5} />
          </button>
        </div>

        {!isCollapsed && (
          <div className={styles.rightPanelContent}>
            {/* 智能体提示词区域 */}
            <div className={styles.rightPanelSection}>
              <h3 className={styles.rightPanelSectionTitle}>智能体提示词</h3>
              {activeSystemPrompt ? (
                <div className={styles.rightPanelPrompt} style={{ fontSize: appConfig.fontSize, lineHeight: appConfig.lineHeight }}>
                  <div className={styles.rightPanelPromptHeader}>
                    <div className={styles.rightPanelPromptRole}>{role!.name}</div>
                    <button
                      className={styles.rightPanelEditBtn}
                      onClick={onOpenPromptEdit}
                      title="编辑智能体提示词"
                    >
                      <EditIcon size={14} />
                    </button>
                  </div>
                  <div
                    ref={promptContentRef}
                    className={`${styles.rightPanelPromptContent}${shouldTruncatePrompt && !isPromptExpanded ? ` ${styles.truncated}` : ''}`}
                  >
                    {activeSystemPrompt}
                  </div>
                  {shouldTruncatePrompt && (
                    <div className={styles.promptExpandControls}>
                      <button
                        className={styles.promptExpandBtn}
                        onClick={onTogglePromptExpand}
                      >
                        {isPromptExpanded ? '收起' : '展开'}
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className={styles.rightPanelEmpty}>当前智能体无提示词</div>
              )}
            </div>

            {/* 快捷短语 */}
            <div className={styles.rightPanelSection}>
              <h3 className={styles.rightPanelSectionTitle}>快捷短语</h3>
              {(role?.quickPhrases?.length ?? 0) > 0 ? (
                <div className={styles.quickPhraseList}>
                  {role!.quickPhrases!.map((phrase) => (
                    <button
                      key={phrase.id}
                      className={styles.quickPhraseItem}
                      title={phrase.text}
                      onClick={() => onQuickPhraseClick(phrase.text)}
                    >
                      <span className={styles.quickPhraseLabel}>{phrase.label}</span>
                      <span className={styles.quickPhraseText}>{phrase.text}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className={styles.rightPanelEmpty}>
                  暂无快捷短语<br />
                  <span style={{ fontSize: '0.75rem' }}>可在设置 › 智能体中添加</span>
                </div>
              )}
            </div>

            {/* MCP 工具调用 */}
            <div className={styles.rightPanelSection}>
              <h3 className={styles.rightPanelSectionTitle}>MCP 工具调用</h3>

              <label className={styles.mcpToggleRow}>
                <input
                  type="checkbox"
                  checked={effectiveMcpConfig.enabled}
                  onChange={(e) => {
                    onUpdateMcpConfig({ ...effectiveMcpConfig, enabled: e.target.checked });
                  }}
                />
                启用工具调用
              </label>

              {effectiveMcpConfig.enabled && (
                <div className={styles.mcpToolList}>
                  <div className={styles.mcpToolRow}>
                    <span className={styles.mcpToolName}>文件工具</span>
                    <div className={styles.mcpToolActions}>
                      <label className={styles.mcpToolToggle} title="激活此工具">
                        <input
                          type="checkbox"
                          checked={effectiveMcpConfig.fileToolEnabled}
                          onChange={(e) => {
                            onUpdateMcpConfig({ ...effectiveMcpConfig, fileToolEnabled: e.target.checked });
                          }}
                        />
                        激活
                      </label>
                      <button
                        className={styles.mcpToolEditBtn}
                        onClick={() => onOpenMCPToolEdit('file')}
                      >
                        修改
                      </button>
                    </div>
                  </div>
                  <div className={styles.mcpToolRow}>
                    <span className={styles.mcpToolName}>代码工具</span>
                    <div className={styles.mcpToolActions}>
                      <label className={styles.mcpToolToggle} title="激活此工具">
                        <input
                          type="checkbox"
                          checked={effectiveMcpConfig.codeToolEnabled}
                          onChange={(e) => {
                            onUpdateMcpConfig({ ...effectiveMcpConfig, codeToolEnabled: e.target.checked });
                          }}
                        />
                        激活
                      </label>
                      <button
                        className={styles.mcpToolEditBtn}
                        onClick={() => onOpenMCPToolEdit('code')}
                      >
                        修改
                      </button>
                    </div>
                  </div>
                  <div className={styles.mcpToolRow}>
                    <span className={styles.mcpToolName}>Python 工具</span>
                    <div className={styles.mcpToolActions}>
                      <label className={styles.mcpToolToggle} title="激活此工具">
                        <input
                          type="checkbox"
                          checked={effectiveMcpConfig.pythonToolEnabled}
                          onChange={(e) => {
                            onUpdateMcpConfig({ ...effectiveMcpConfig, pythonToolEnabled: e.target.checked });
                          }}
                        />
                        激活
                      </label>
                      <button
                        className={styles.mcpToolEditBtn}
                        onClick={handleOpenPythonEdit}
                      >
                        修改
                      </button>
                    </div>
                  </div>
                  <div className={styles.mcpToolRow}>
                    <span className={styles.mcpToolName}>Web 工具</span>
                    <div className={styles.mcpToolActions}>
                      <label className={styles.mcpToolToggle} title="激活此工具">
                        <input
                          type="checkbox"
                          checked={effectiveMcpConfig.webToolEnabled}
                          onChange={(e) => {
                            onUpdateMcpConfig({ ...effectiveMcpConfig, webToolEnabled: e.target.checked });
                          }}
                        />
                        激活
                      </label>
                      <button
                        className={styles.mcpToolEditBtn}
                        onClick={() => onOpenMCPToolEdit('web')}
                      >
                        修改
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
