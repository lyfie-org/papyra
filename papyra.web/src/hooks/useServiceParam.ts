import { useSearchParams } from 'react-router-dom';

/**
 * Which service tab is open, kept in the address (`?tab=notifications&service=telegram`) so a link, a reload or the
 * back button lands on the same one. An unknown or missing value falls back to `legacy` (the old `s=` section
 * links, such as `s=channels-discord`) and then to `fallback`. Changing it replaces the entry rather than
 * stacking history, and drops any stale `s=` so a section is not chased after the person moved on.
 */
export function useServiceParam(
  valid: readonly string[],
  fallback: string,
  legacy?: (section: string | null) => string | null,
): [string, (id: string) => void] {
  const [params, setParams] = useSearchParams();
  const asked = params.get('service');
  const fromSection = legacy?.(params.get('s')) ?? null;
  const value = asked && valid.includes(asked) ? asked
    : fromSection && valid.includes(fromSection) ? fromSection
    : valid.includes(fallback) ? fallback : valid[0];

  const set = (id: string) => setParams(prev => {
    const next = new URLSearchParams(prev);
    next.set('service', id);
    next.delete('s');
    return next;
  }, { replace: true });
  return [value, set];
}
