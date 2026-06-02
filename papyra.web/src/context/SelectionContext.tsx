import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

interface SelectionContextValue {
  selectedNotes: Set<string>;
  isSelected: (id: string) => boolean;
  toggleSelect: (id: string) => void;
  clearSelection: () => void;
  hasSelection: boolean;
}

const SelectionContext = createContext<SelectionContextValue | null>(null);

export function SelectionProvider({ children }: { children: ReactNode }) {
  const [selectedNotes, setSelectedNotes] = useState<Set<string>>(new Set());

  const isSelected = useCallback((id: string) => selectedNotes.has(id), [selectedNotes]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedNotes(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedNotes(new Set()), []);

  return (
    <SelectionContext.Provider value={{
      selectedNotes,
      isSelected,
      toggleSelect,
      clearSelection,
      hasSelection: selectedNotes.size > 0,
    }}>
      {children}
    </SelectionContext.Provider>
  );
}

export function useSelection() {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error('useSelection must be used within SelectionProvider');
  return ctx;
}
