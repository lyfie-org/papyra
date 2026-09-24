import type { Location } from 'react-router-dom';

/**
 * The router state carried into the editor so it knows where to go on close.
 *
 * The editor lives at /note/:id, nested under the Notes route so the grid stays
 * mounted behind it. That nesting made "close" mean "go to /" — which is right
 * when you opened the note from Notes, and wrong from every other page: opening
 * a list from To Do and closing it dumped you on Notes.
 */
export interface NoteOrigin {
  from: string;
}

/** Remember the page a note was opened from. Pass as a Link's `state`. */
export function originState(location: Location): NoteOrigin {
  return { from: location.pathname + location.search };
}

// The last page (path + query) the user was on that is not a note. Recorded by
// <OriginTracker/> in the workspace shell, so a card can link to its note
// without reading the router location itself: a card that subscribes to the
// location re-renders on every navigation, and opening one note re-rendered
// every card on the desk.
let lastPage: string | null = null;

/** Record the current page as the place to return to (ignores note routes). */
export function rememberPage(location: Pick<Location, 'pathname' | 'search'>): void {
  if (!location.pathname.startsWith('/note/')) lastPage = location.pathname + location.search;
}

/**
 * Where closing the editor should land: the origin a link carried, else the
 * last page visited, else Notes.
 */
export function closeTarget(location: Location): string {
  const state = location.state as Partial<NoteOrigin> | null;
  const from = state?.from ?? lastPage;
  // Never bounce back into another note — that would reopen the editor.
  if (typeof from === 'string' && from.length > 0 && !from.startsWith('/note/')) return from;
  return '/';
}
