import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import TopNav from './TopNav';
import LeftSidebar from './LeftSidebar';
import SearchPalette from './SearchPalette';
import ToastContainer from './Toast';
import { LayoutProvider, useLayout } from '../context/LayoutContext';
import { SelectionProvider } from '../context/SelectionContext';
import { SignalRProvider } from '../context/SignalRContext';
import { ToastProvider } from '../context/ToastContext';
import { OfflineQueueProvider } from '../context/OfflineQueueContext';
import './AppLayout.css';

const IGNORED_KEYS = new Set([
  'Escape', 'Enter', 'Tab', 'Backspace', 'Delete',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
  'CapsLock', 'Shift', 'Control', 'Alt', 'Meta',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6',
  'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);

function AppLayoutInner() {
  const { isSearchOpen, openSearch } = useLayout();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isSearchOpen) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (IGNORED_KEYS.has(e.key) || e.key.length !== 1) return;

      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) return;

      openSearch(e.key);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isSearchOpen, openSearch]);

  return (
    <div className="app-layout">
      <TopNav />
      <LeftSidebar />
      <main className="app-main">
        <Outlet />
      </main>
      <SearchPalette />
      <ToastContainer />
    </div>
  );
}

export default function AppLayout() {
  return (
    <ToastProvider>
      <OfflineQueueProvider>
        <LayoutProvider>
          <SelectionProvider>
            <SignalRProvider>
              <AppLayoutInner />
            </SignalRProvider>
          </SelectionProvider>
        </LayoutProvider>
      </OfflineQueueProvider>
    </ToastProvider>
  );
}
