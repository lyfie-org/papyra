import { useCallback, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  currentUnlockToken, fetchVaultStatus, lockVault, subscribeUnlock, type VaultStatus,
} from '../lib/vault';

export const VAULT_KEY = ['vault'];

/** Whether the vault is open on this session right now (a live unlock token). */
export function useVaultOpen(): boolean {
  return useSyncExternalStore(subscribeUnlock, () => currentUnlockToken() !== null, () => false);
}

/** The vault's state from the server (PIN set? locked out? biometrics usable here?) plus lock/refresh. */
export function useVault() {
  const queryClient = useQueryClient();
  const status = useQuery<VaultStatus>({ queryKey: VAULT_KEY, queryFn: fetchVaultStatus });
  const open = useVaultOpen();

  const refresh = useCallback(() => queryClient.invalidateQueries({ queryKey: VAULT_KEY }), [queryClient]);
  const lock = useCallback(async () => { await lockVault(); }, []);

  return { status, open, refresh, lock };
}
