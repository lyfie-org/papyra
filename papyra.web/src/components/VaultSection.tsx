import { useId, type ReactNode } from 'react';
import { useCollapsed } from '../hooks/useCollapsed';
import SectionToggle from './SectionToggle';

/** One kind of locked thing on the Vault page; its heading folds it, remembered on this device. */
export default function VaultSection({ name, label, count, children }: {
  /** Storage name (`notes`, `todo`, `journal`). */
  name: string;
  label: string;
  count: number;
  children: ReactNode;
}) {
  const id = useId();
  const [folded, toggle] = useCollapsed(`vault:${name}`);
  return (
    <section className="vault-section" aria-label={label}>
      <SectionToggle label={label} count={count} open={!folded} onToggle={toggle} controls={id} />
      {!folded && <div id={id}>{children}</div>}
    </section>
  );
}
