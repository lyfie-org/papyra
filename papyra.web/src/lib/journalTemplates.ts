import { longDate, weekdayName } from './journalDay';

export interface TemplateContext {
  /** The day the page is for (`yyyy-MM-dd`). */
  day: string;
  /** How many days in a row, counting this one. */
  streak: number;
}

/** The words a template may use, for the editor's hint. */
export const TEMPLATE_TOKENS = ['{{date}}', '{{weekday}}', '{{streak}}'] as const;

/**
 * Fill a template's `{{date}}`, `{{weekday}}` and `{{streak}}`. A word in braces
 * that is none of those is left exactly as written — a template can say anything.
 */
export function expandTemplate(body: string, { day, streak }: TemplateContext): string {
  return body.replace(/\{\{\s*(date|weekday|streak)\s*\}\}/gi, (_, token: string) => {
    switch (token.toLowerCase()) {
      case 'date': return longDate(day);
      case 'weekday': return weekdayName(day);
      default: return String(streak);
    }
  });
}

/** The streak a page would show once it is written: today counts the moment it has words. */
export function streakWith(stats: { current: number; todayWritten: boolean } | undefined, isToday: boolean): number {
  if (!stats) return 1;
  return isToday && !stats.todayWritten ? stats.current + 1 : Math.max(1, stats.current);
}
