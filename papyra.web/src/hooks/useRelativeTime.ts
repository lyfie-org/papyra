import { useState, useEffect } from 'react';

function format(date: Date): string {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 30)     return 'Just now';
  if (s < 90)     return '1 min ago';
  if (s < 3600)   return `${Math.floor(s / 60)} mins ago`;
  if (s < 5400)   return '1 hr ago';
  if (s < 86400)  return `${Math.floor(s / 3600)} hrs ago`;
  if (s < 172800) return 'Yesterday';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function useRelativeTime(iso: string | undefined): string {
  const [label, setLabel] = useState(() => (iso ? format(new Date(iso)) : ''));

  useEffect(() => {
    if (!iso) { setLabel(''); return; }
    const tick = () => setLabel(format(new Date(iso)));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [iso]);

  return label;
}
