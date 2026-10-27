import type { Mood } from '../types/journal';

/** How a day felt, worst to best. The glyph for each lives in components/journal/MoodPicker. */
export const MOODS: { value: Mood; label: string }[] = [
  { value: 1, label: 'Rough' },
  { value: 2, label: 'Low' },
  { value: 3, label: 'Okay' },
  { value: 4, label: 'Good' },
  { value: 5, label: 'Great' },
];

export function moodLabel(mood: Mood | null | undefined): string {
  return MOODS.find((m) => m.value === mood)?.label ?? '';
}
