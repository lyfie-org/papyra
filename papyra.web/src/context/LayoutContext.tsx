import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

interface LayoutContextValue {
  viewMode: 'grid' | 'list';
  setViewMode: (mode: 'grid' | 'list') => void;
  isMobileNavOpen: boolean;
  toggleMobileNav: () => void;
  closeMobileNav: () => void;
  isSearchOpen: boolean;
  searchSeed: string;
  openSearch: (seed?: string) => void;
  closeSearch: () => void;
}

const LayoutContext = createContext<LayoutContextValue | null>(null);

export function LayoutProvider({ children }: { children: ReactNode }) {
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchSeed, setSearchSeed] = useState('');

  const openSearch = useCallback((seed = '') => {
    setSearchSeed(seed);
    setIsSearchOpen(true);
  }, []);

  const closeSearch = useCallback(() => {
    setIsSearchOpen(false);
    setSearchSeed('');
  }, []);

  return (
    <LayoutContext.Provider value={{
      viewMode,
      setViewMode,
      isMobileNavOpen,
      toggleMobileNav: () => setIsMobileNavOpen(v => !v),
      closeMobileNav: () => setIsMobileNavOpen(false),
      isSearchOpen,
      searchSeed,
      openSearch,
      closeSearch,
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
