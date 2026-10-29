// A checklist is a <ul> whose items are role="checkbox" — which no longer count as list
// items, so a screen reader and axe both find a list with nothing valid in it. Naming such a
// list a group says what it is (a set of related checkboxes) and satisfies the list rule.
// Lexical writes the items; this only names their container, wherever an editor draws one.
// (Belongs in the editor itself: see the journal log's luthor follow-ups.)

const CHECKLIST = 'ul.luthor-list-ul:not([role])';

function name(root: ParentNode): void {
  for (const list of root.querySelectorAll<HTMLElement>(CHECKLIST)) {
    if (list.querySelector(':scope > li[role="checkbox"]')) list.setAttribute('role', 'group');
  }
}

/** Starts naming checklists as editors draw them; returns a function that stops. */
export function installChecklistRoles(): () => void {
  if (typeof document === 'undefined') return () => {};
  let queued = false;
  let live = true;
  const run = () => { queued = false; if (live) name(document); };
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(run);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  name(document);
  return () => { live = false; observer.disconnect(); };
}

export { name as nameChecklists };
