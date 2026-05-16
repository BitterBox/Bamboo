// src/pages/ToolMarket.tsx
// 工具市场页面：管理内置工具和用户工具

import { useState, useEffect } from 'react';
import { mcpRegistry } from '../services/mcp';
import { getToolMeta } from '../services/mcp/manifestLoader';
import type { ToolDefinition } from '../types';

type Tab = 'builtin' | 'user' | 'discover';

export default function ToolMarket() {
  const [tab, setTab] = useState<Tab>('builtin');
  const [tools, setTools] = useState<ToolDefinition[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const defs = mcpRegistry.getDefinitions();
    defs.sort((a, b) => {
      const metaA = getToolMeta(a.function.name);
      const metaB = getToolMeta(b.function.name);
      const catA = metaA?.category || 'custom';
      const catB = metaB?.category || 'custom';
      const order = ['file', 'code', 'python', 'web', 'custom'];
      const idxA = order.indexOf(catA);
      const idxB = order.indexOf(catB);
      if (idxA !== idxB) return idxA - idxB;
      return a.function.name.localeCompare(b.function.name);
    });
    setTools(defs);
  }, [refreshKey]);

  const builtinTools = tools.filter(t => {
    const meta = getToolMeta(t.function.name);
    return meta?.category !== 'custom';
  });

  const userTools = tools.filter(t => {
    const meta = getToolMeta(t.function.name);
    return meta?.category === 'custom' || !meta;
  });

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: 'builtin', label: '内置工具', count: builtinTools.length },
    { key: 'user', label: '用户工具', count: userTools.length },
    { key: 'discover', label: '发现', count: 0 },
  ];

  return (
    <div style={{ padding: '24px', maxWidth: '900px', margin: '0 auto', height: '100%', overflowY: 'auto' }}>
      <h1 style={{ fontSize: '24px', fontWeight: 600, marginBottom: '8px' }}>🛠️ 工具市场</h1>
      <p style={{ color: '#666', marginBottom: '24px', fontSize: '14px' }}>
        管理 MCP 工具。用户工具放在 <code>{'{dataDir}/tools/user/'}</code> 目录下，刷新页面即可加载。
      </p>

      {/* 标签栏 */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '24px', borderBottom: '1px solid #e0e0e0' }}>
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: '10px 20px',
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              fontSize: '14px',
              fontWeight: tab === t.key ? 600 : 400,
              color: tab === t.key ? '#1a73e8' : '#666',
              borderBottom: tab === t.key ? '2px solid #1a73e8' : '2px solid transparent',
              marginBottom: '-1px',
            }}
          >
            {t.label}
            {t.count > 0 && (
              <span style={{
                marginLeft: '6px',
                background: tab === t.key ? '#e8f0fe' : '#f0f0f0',
                color: tab === t.key ? '#1a73e8' : '#888',
                borderRadius: '10px',
                padding: '1px 8px',
                fontSize: '12px',
              }}>
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* 内容区 */}
      {tab === 'builtin' && <BuiltinToolList tools={builtinTools} />}
      {tab === 'user' && <UserToolList tools={userTools} onRefresh={() => setRefreshKey(k => k + 1)} />}
      {tab === 'discover' && <DiscoverPlaceholder />}
    </div>
  );
}

// ── 内置工具列表 ──────────────────────────────────────────

function BuiltinToolList({ tools }: { tools: ToolDefinition[] }) {
  return (
    <div>
      {tools.length === 0 ? (
        <p style={{ color: '#999' }}>没有已注册的内置工具</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {tools.map(tool => (
            <ToolCard key={tool.function.name} tool={tool} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── 用户工具列表 ──────────────────────────────────────────

function UserToolList({ tools, onRefresh }: { tools: ToolDefinition[]; onRefresh: () => void }) {
  return (
    <div>
      <div style={{ marginBottom: '16px', padding: '12px', background: '#f5f5f5', borderRadius: '8px', fontSize: '13px', color: '#666' }}>
        <p style={{ margin: 0 }}>
          💡 将 <code>.json</code> 清单文件放入 <code>{'{dataDir}/tools/user/'}</code> 目录，然后刷新页面即可加载。
        </p>
        <p style={{ margin: '8px 0 0 0' }}>
          支持的执行器类型：<code>http</code>、<code>shell</code>、<code>python_script</code>
        </p>
      </div>

      {tools.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px', color: '#999' }}>
          <p style={{ fontSize: '48px', margin: '0 0 16px 0' }}>📦</p>
          <p>还没有用户安装的工具</p>
          <p style={{ fontSize: '13px' }}>在 user 目录下添加 JSON 清单文件即可</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {tools.map(tool => (
            <ToolCard key={tool.function.name} tool={tool} isUser />
          ))}
        </div>
      )}
    </div>
  );
}

// ── 发现（占位）──────────────────────────────────────────

function DiscoverPlaceholder() {
  return (
    <div style={{ textAlign: 'center', padding: '60px 20px', color: '#999' }}>
      <p style={{ fontSize: '48px', margin: '0 0 16px 0' }}>🌐</p>
      <p style={{ fontSize: '16px', fontWeight: 500, color: '#555' }}>在线工具市场</p>
      <p style={{ fontSize: '14px' }}>
        浏览和安装社区分享的工具清单。
        <br />
        此功能将在后续版本中上线。
      </p>
      <div style={{
        marginTop: '24px',
        padding: '16px',
        background: '#f9f9f9',
        borderRadius: '8px',
        textAlign: 'left',
        fontSize: '13px',
        maxWidth: '500px',
        margin: '24px auto 0',
      }}>
        <p style={{ fontWeight: 600, margin: '0 0 8px 0' }}>📋 规划中的功能：</p>
        <ul style={{ margin: 0, paddingLeft: '20px', lineHeight: 1.8 }}>
          <li>浏览社区分享的工具清单</li>
          <li>一键安装到 user 目录</li>
          <li>工具评分和评论</li>
          <li>分享自己创建的工具</li>
        </ul>
      </div>
    </div>
  );
}

// ── 工具卡片 ──────────────────────────────────────────────

function ToolCard({ tool, isUser }: { tool: ToolDefinition; isUser?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const meta = getToolMeta(tool.function.name);
  const category = meta?.category || 'custom';
  const params = (tool.function.parameters as Record<string, unknown>)?.properties as Record<string, { type: string; description?: string }> | undefined;

  const categoryColors: Record<string, string> = {
    file: '#4caf50',
    code: '#2196f3',
    python: '#ff9800',
    web: '#9c27b0',
    custom: '#607d8b',
  };

  return (
    <div style={{
      border: '1px solid #e0e0e0',
      borderRadius: '8px',
      padding: '16px',
      background: '#fff',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
           onClick={() => setExpanded(!expanded)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{
            background: categoryColors[category] || '#607d8b',
            color: '#fff',
            borderRadius: '4px',
            padding: '2px 8px',
            fontSize: '11px',
            fontWeight: 600,
            textTransform: 'uppercase',
          }}>
            {category}
          </span>
          <span style={{ fontWeight: 600, fontSize: '15px', fontFamily: 'monospace' }}>
            {tool.function.name}
          </span>
          {isUser && <span style={{ fontSize: '11px', color: '#999' }}>用户</span>}
        </div>
        <span style={{ color: '#999', fontSize: '12px' }}>{expanded ? '▲' : '▼'}</span>
      </div>

      <p style={{ margin: '8px 0 0 0', fontSize: '13px', color: '#555', lineHeight: 1.5 }}>
        {tool.function.description}
      </p>

      {expanded && (
        <div style={{ marginTop: '12px', borderTop: '1px solid #f0f0f0', paddingTop: '12px' }}>
          {params && Object.keys(params).length > 0 && (
            <div style={{ marginBottom: '12px' }}>
              <p style={{ fontSize: '12px', fontWeight: 600, color: '#888', margin: '0 0 6px 0' }}>参数：</p>
              {Object.entries(params).map(([name, schema]) => (
                <div key={name} style={{ fontSize: '12px', marginBottom: '4px', paddingLeft: '12px' }}>
                  <code style={{ background: '#f5f5f5', padding: '1px 4px', borderRadius: '3px' }}>{name}</code>
                  <span style={{ color: '#999' }}> ({schema.type})</span>
                  {schema.description && <span style={{ color: '#666' }}> — {schema.description.slice(0, 80)}{schema.description.length > 80 ? '…' : ''}</span>}
                </div>
              ))}
            </div>
          )}

          {meta && (
            <div style={{ fontSize: '12px', color: '#888' }}>
              <span>权限：{meta.read ? '📖 读' : ''}{meta.write ? ' ✏️ 写' : ''}{!meta.read && !meta.write ? ' 无特殊限制' : ''}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}