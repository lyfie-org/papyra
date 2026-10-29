// Gentle things to start from. They are only ever the empty page's placeholder —
// never saved, never part of the entry — and one day always gets the same one,
// so reopening a page doesn't make the prompt flicker.

export const JOURNAL_PROMPTS = [
  'What is on your mind tonight?',
  'What made today a little easier?',
  'Who did you talk to today?',
  'What are you looking forward to?',
  'What did you notice that you usually walk past?',
  'What surprised you today?',
  'What would you like to remember about today?',
  'What are you grateful for, however small?',
  'What is taking up room in your head?',
  'What did you learn today?',
  'How is your body feeling?',
  'What did you eat that you enjoyed?',
  'What is one thing you did well?',
  'What would you tell yourself a year ago?',
  'What do you need less of?',
  'What do you need more of?',
  'Where did your attention go today?',
  'What was the best part of the day?',
  'What was the hardest part of the day?',
  'What are you putting off, and why?',
  'What song would go with today?',
  'What did you see out of the window?',
  'Who would you like to write to?',
  'What small thing could you do tomorrow?',
  'What are you curious about?',
  'What did you finish?',
  'What did you start?',
  'What made you laugh?',
  'What did you let go of?',
  'Write anything. It does not have to be good.',
] as const;

/** A stable pick for a day (`yyyy-MM-dd`). */
export function promptFor(day: string): string {
  let h = 0;
  for (let i = 0; i < day.length; i++) h = (h * 31 + day.charCodeAt(i)) >>> 0;
  return JOURNAL_PROMPTS[h % JOURNAL_PROMPTS.length];
}
