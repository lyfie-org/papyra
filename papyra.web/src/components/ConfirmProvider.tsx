import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import ConfirmDialog from './ConfirmDialog';
import { ConfirmContext, type Ask, type ConfirmRequest } from '../lib/confirmContext';


/**
 * Promise-based confirmation, so a call site reads like the `window.confirm` it
 * replaces:
 *
 *   if (!(await confirm({ ... }))) return;
 *
 * That shape matters. The alternative — per-component dialog state, a pending
 * action stashed in a ref, a handler to run it — is a lot of machinery to add to
 * every button that deletes something, and machinery is where the bugs live.
 * Here one dialog is mounted for the whole app and the caller just awaits.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const ask = useCallback<Ask>((next) => {
    setRequest(next);
    return new Promise<boolean>(resolve => { resolver.current = resolve; });
  }, []);

  const settle = useCallback((ok: boolean) => {
    setRequest(null);
    resolver.current?.(ok);
    resolver.current = null;
  }, []);

  const value = useMemo(() => ask, [ask]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {request && (
        <ConfirmDialog
          {...request}
          onConfirm={() => settle(true)}
          onCancel={() => settle(false)}
        />
      )}
    </ConfirmContext.Provider>
  );
}

