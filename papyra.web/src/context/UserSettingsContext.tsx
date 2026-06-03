import {
  createContext,
  useContext,
  useEffect,
  type ReactNode,
} from 'react';
import { useUserSettings, useUpdateSettings } from '../hooks/useUserSettings';
import type { UpdateSettingsRequest, UserSettings } from '../types';

interface UserSettingsContextValue {
  settings: UserSettings | undefined;
  isLoading: boolean;
  update: (patch: UpdateSettingsRequest) => void;
}

const UserSettingsContext = createContext<UserSettingsContextValue | null>(null);

export function UserSettingsProvider({ children }: { children: ReactNode }) {
  const { data: settings, isLoading } = useUserSettings();
  const { mutate } = useUpdateSettings();

  // Apply theme from server settings as soon as they load and keep localStorage
  // in sync so useTheme() reads the correct value on any remount/navigation.
  useEffect(() => {
    if (settings?.theme) {
      const t = settings.theme;
      document.documentElement.setAttribute('data-theme', t);
      document.documentElement.style.colorScheme = t;
      localStorage.setItem('papyra-theme', t);
    }
  }, [settings?.theme]);

  return (
    <UserSettingsContext.Provider value={{ settings, isLoading, update: mutate }}>
      {children}
    </UserSettingsContext.Provider>
  );
}

export function useUserSettingsCtx() {
  const ctx = useContext(UserSettingsContext);
  if (!ctx) throw new Error('useUserSettingsCtx must be used inside UserSettingsProvider');
  return ctx;
}
