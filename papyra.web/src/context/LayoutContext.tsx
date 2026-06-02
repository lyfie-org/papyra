import { createContext, useContext, useState, type ReactNode } from 'react';

interface LayoutContextValue {
  viewMode: 'grid' | 'list';
  setViewMode: (mode: 'grid' | 'list') => void;
  isMobileNavOpen: boolean;
  toggleMobileNav: () => void;
  closeMobileNav: () => void;
  isSearchOpen: boolean;
  openSearch: () => void;
  closeSearch: () => void;
}

const LayoutContext = createContext<LayoutContextValue | null>(null);

export function LayoutProvider({ children }: { children: ReactNode }) {
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  return (
    <LayoutContext.Provider value={{
      viewMode,
      setViewMode,
      isMobileNavOpen,
      toggleMobileNav: () => setIsMobileNavOpen(v => !v),
      closeMobileNav: () => setIsMobileNavOpen(false),
      isSearchOpen,
      openSearch:  () => setIsSearchOpen(true),
      closeSearch: () => setIsSearchOpen(false),
    }}>
      {children}
    </LayoutContext.Provider>
  );
}

export function useLayout() {
  const ctx = useContext(LayoutContext);
  if (!ctx) throw new Error('useLayout must be used within LayoutProvider');
  return ctx;
}
