import type { Note } from '../types/note';
import { swatchName } from './noteColors';

export type SmartField = 'tag' | 'color' | 'pinned' | 'kind' | 'text';

export interface SmartRule {
  field: SmartField;
  value: string;
}

export interface SmartRules {
  match: 'all' | 'any';
  conditions: SmartRule[];
}

export function parseRules(rulesJson: string): SmartRules | null {
  try {
    const r = JSON.parse(rulesJson) as SmartRules;
    return r && Array.isArray(r.conditions) ? r : null;
  } catch {
    return null;
  }
}

const eq = (a: string | null | undefined, b: string) => (a ?? '').toLowerCase() === b.toLowerCase();

/**
 * Whether a note belongs to a collection. The same rules as the server's
 * SmartCollectionEvaluator, run over the notes the client already holds — so a
 * collection updates the moment a note's tags, colour or pin change instead of
 * waiting for its server result to be refetched (it wasn't, until a reload).
 *
 * A secure note arrives with its body withheld, so `text` can only ever match
 * its title here — exactly what the server allows.
 */
export function matchesRules(note: Note, rules: SmartRules): boolean {
  const conditions = rules.conditions ?? [];
  if (conditions.length === 0) return false;
  const one = (c: SmartRule): boolean => {
    const value = c.value ?? '';
    switch ((c.field ?? '').toLowerCase()) {
      case 'tag':
      case 'tags':
        return (note.tags ?? []).some((t) => eq(t, value));
      case 'color': return eq(note.color, value);
      case 'pinned': return note.pinned === (value.toLowerCase() === 'true');
      case 'kind': return eq(note.kind, value);
      case 'text': {
        const v = value.toLowerCase();
        return (note.title ?? '').toLowerCase().includes(v)
          || (!note.secure && (note.body ?? '').toLowerCase().includes(v));
      }
      default: return false;
    }
  };
  return rules.match === 'any' ? conditions.some(one) : conditions.every(one);
}

/** One condition in words: "tagged work", "coloured Sage", "pinned", "a to-do". */
export function describeRule(rule: SmartRule): string {
  switch (rule.field) {
    case 'tag': return `tagged ${rule.value}`;
    case 'color': return `coloured ${swatchName(rule.value) ?? rule.value}`;
    case 'pinned': return rule.value === 'true' ? 'pinned' : 'not pinned';
    case 'kind': return rule.value === 'todo' ? 'a to-do list' : 'a note';
    case 'text': return `mentions “${rule.value}”`;
    default: return `${rule.field}: ${rule.value}`;
  }
}

export function describeRules(rules: SmartRules): string {
  const parts = rules.conditions.map(describeRule);
  if (parts.length <= 1) return parts[0] ?? '';
  return parts.join(rules.match === 'any' ? ' or ' : ' and ');
}
