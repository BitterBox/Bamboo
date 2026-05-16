import { Link, useLocation } from 'react-router-dom';
import styles from './Layout.module.css';
import { ChatIcon, FileIcon, InspectorIcon, SettingsIcon, ToolsIcon } from './icons';
import Chat from '../pages/Chat';
import FileManager from '../pages/FileManager';
import RequestInspector from '../pages/RequestInspector';
import Settings from '../pages/Settings';
import ToolMarket from '../pages/ToolMarket';

export default function Layout() {
  const location = useLocation();

  return (
    <div className={styles.layout}>
      {/* 左侧纵向导航栏 */}
      <nav className={styles.sidebar}>
        <Link
          to="/"
          className={`${styles.navItem} ${location.pathname === '/' ? styles.active : ''}`}
          title="对话"
        >
          <ChatIcon />
        </Link>
        <Link
          to="/files"
          className={`${styles.navItem} ${location.pathname === '/files' ? styles.active : ''}`}
          title="文件管理"
        >
          <FileIcon />
        </Link>
        <Link
          to="/inspector"
          className={`${styles.navItem} ${location.pathname === '/inspector' ? styles.active : ''}`}
          title="API 请求"
        >
          <InspectorIcon />
        </Link>
        <Link
          to="/tools"
          className={`${styles.navItem} ${location.pathname === '/tools' ? styles.active : ''}`}
          title="工具市场"
        >
          <ToolsIcon />
        </Link>
        <Link
          to="/settings"
          className={`${styles.navItem} ${location.pathname === '/settings' ? styles.active : ''}`}
          title="设置"
        >
          <SettingsIcon />
        </Link>
      </nav>

      {/* 主内容区域 —— 所有页面保持挂载，用 display 切换，保留滚动位置 */}
      <main className={styles.main}>
        <div className={styles.pageSlot} style={{ display: location.pathname === '/' ? undefined : 'none' }}>
          <Chat />
        </div>
        <div className={styles.pageSlot} style={{ display: location.pathname === '/files' ? undefined : 'none' }}>
          <FileManager />
        </div>
        <div className={styles.pageSlot} style={{ display: location.pathname === '/inspector' ? undefined : 'none' }}>
          <RequestInspector />
        </div>
        <div className={styles.pageSlot} style={{ display: location.pathname === '/tools' ? undefined : 'none' }}>
          <ToolMarket />
        </div>
        <div className={styles.pageSlot} style={{ display: location.pathname === '/settings' ? undefined : 'none' }}>
          <Settings />
        </div>
      </main>
    </div>
  );
}
