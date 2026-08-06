import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import './KnowledgeHeatmap.css';

type ActivityTree = Record<string, Record<string, Record<string, number>>>;

const WEEKS = 26;
const CELL = 13; // px per cell (incl. gap)

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function level(count: number): number {
  if (count <= 0) return 0;
  if (count < 2) return 1;
  if (count < 4) return 2;
  if (count < 7) return 3;
  return 4;
}

// GitHub-style contribution grid over the last ~26 weeks. Cell intensity encodes how
// many notes were last modified that day; clicking a cell filters the dashboard to
// that day (click again to clear).
export default function KnowledgeHeatmap({
  selectedDay,
  onSelectDay,
}: {
  selectedDay: string | null;
  onSelectDay: (day: string | null) => void;
}) {
  const { data: tree } = useQuery<ActivityTree>({
    queryKey: ['activity'],
    queryFn: async () => {
      const res = await fetch('/api/notes/activity');
      if (!res.ok) throw new Error(`GET activity failed: ${res.status}`);
      return res.json();
    },
  });

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const [y, months] of Object.entries(tree ?? {}))
      for (const [m, days] of Object.entries(months))
        for (const [d, c] of Object.entries(days))
          map.set(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`, c);
    return map;
  }, [tree]);

  const cells = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // Start on the Sunday of the week WEEKS-1 weeks ago.
    const start = new Date(today);
    start.setDate(start.getDate() - (WEEKS - 1) * 7 - today.getDay());

    const out: { key: string; x: number; y: number; count: number }[] = [];
    for (let i = 0; i < WEEKS * 7; i++) {
      const day = new Date(start);
      day.setDate(start.getDate() + i);
      if (day > today) break;
      const key = iso(day);
      out.push({ key, x: Math.floor(i / 7) * CELL, y: (i % 7) * CELL, count: counts.get(key) ?? 0 });
    }
    return out;
  }, [counts]);

  const width = WEEKS * CELL;
  const height = 7 * CELL;

  return (
    <section className="heatmap" aria-label="Knowledge heatmap">
      <svg className="heatmap__svg" viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img">
        {cells.map((c) => (
          <rect
            key={c.key}
            x={c.x}
            y={c.y}
            width={CELL - 2}
            height={CELL - 2}
            rx={2}
            className={`heatmap__cell${selectedDay === c.key ? ' is-selected' : ''}`}
            data-level={level(c.count)}
            onClick={() => onSelectDay(selectedDay === c.key ? null : c.key)}
          >
            <title>{`${c.key}: ${c.count} note${c.count === 1 ? '' : 's'}`}</title>
          </rect>
        ))}
      </svg>
    </section>
  );
}
