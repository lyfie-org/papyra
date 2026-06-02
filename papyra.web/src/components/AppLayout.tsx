import { Outlet } from 'react-router-dom';
import TopNav from './TopNav';
import LeftSidebar from './LeftSidebar';
import SearchPalette from './SearchPalette';
import { LayoutProvider } from '../context/LayoutContext';
import { SelectionProvider } from '../context/SelectionContext';
import './AppLayout.css';

function AppLayoutInner() {
  return (
    <div className="app-layout">
      <TopNav />
      <LeftSidebar />
      <main className="app-main">
        <Outlet />
      </main>
      <SearchPalette />
    </div>
  );
}

export default function AppLayout() {
  return (
    <LayoutProvider>
      <SelectionProvider>
        <AppLayoutInner />
      </SelectionProvider>
    </LayoutProvider>
  );
}
