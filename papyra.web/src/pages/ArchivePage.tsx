import { Archive } from '@phosphor-icons/react';

export default function ArchivePage() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12, opacity: 0.4 }}>
      <Archive size={40} aria-hidden="true" />
      <p style={{ fontFamily: 'var(--sans)', fontSize: '0.9rem', margin: 0 }}>Archive is empty</p>
    </div>
  );
}
