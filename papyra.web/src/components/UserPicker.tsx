import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import Avatar from './Avatar';
import './UserPicker.css';

interface Suggestion { username: string; name: string }

/**
 * The "who to share with" field: a username box that lists the people on this
 * Papyra as soon as it is focused and narrows as you type (the same directory
 * the @ typeahead uses). Picking someone fills the box; Enter with nobody
 * highlighted submits what was typed.
 *
 * A real combobox rather than a <datalist>: a datalist only shows once you type,
 * can't be themed, and password managers treated the bare text box as a login
 * field and stacked their own popup on top.
 */
export default function UserPicker({ value, onChange, onSubmit, exclude, autoFocus, placeholder = 'Add by username' }: {
  value: string;
  onChange: (value: string) => void;
  /** Enter with no suggestion highlighted. */
  onSubmit?: () => void;
  /** Usernames not to offer (already shared with). */
  exclude?: ReadonlySet<string>;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Suggestion[]>([]);
  const [active, setActive] = useState(-1);

  // Fetch while open, following the text (debounced). An empty query lists the
  // first page of accounts, which is what a freshly focused box shows.
  useEffect(() => {
    if (!open) return;
    const q = value.trim().replace(/^@/, '');
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/users/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : []))
        .then((data: Suggestion[]) => { setRows(Array.isArray(data) ? data : []); setActive(-1); })
        .catch(() => { /* aborted or offline: keep what we had */ });
    }, 120);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [open, value]);

  const shown = exclude ? rows.filter((r) => !exclude.has(r.username.toLowerCase())) : rows;
  const expanded = open && shown.length > 0;

  // The list is position: fixed, under the whole field box it sits in: the
  // dialog scrolls (overflow: auto), which would clip an absolute list.
  useLayoutEffect(() => {
    if (!expanded) return;
    const place = () => {
      const anchor = wrapRef.current?.closest('.share__invite') ?? wrapRef.current;
      if (!anchor) return;
      const r = anchor.getBoundingClientRect();
      setPos({ top: r.bottom + 4, left: r.left, width: r.width });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [expanded]);

  function pick(s: Suggestion) {
    onChange(s.username);
    setOpen(false);
    setActive(-1);
    inputRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      if (shown.length === 0) return;
      const n = shown.length;
      const down = e.key === 'ArrowDown';
      setActive((i) => (down ? (i + 1) % n : i <= 0 ? n - 1 : i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (expanded && active >= 0 && shown[active]) pick(shown[active]);
      else { setOpen(false); onSubmit?.(); }
    } else if (e.key === 'Escape' && expanded) {
      // This press closes the list, not the dialog around it.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  }

  return (
    <div className="user-picker" ref={wrapRef}>
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label="Username"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={expanded && active >= 0 ? `${listId}-${active}` : undefined}
        // Not a login field: keep browsers and password managers from filling
        // it or hanging their own account popup off it.
        name="papyra-share-with"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        data-1p-ignore
        data-lpignore="true"
        data-bwignore="true"
        data-form-type="other"
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {expanded && (
        <ul
          className="user-picker__list"
          id={listId}
          role="listbox"
          aria-label="People"
          style={pos ? { top: pos.top, left: pos.left, width: pos.width } : { visibility: 'hidden' }}
        >
          {shown.map((s, i) => (
            <li
              key={s.username}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`user-picker__option${i === active ? ' is-active' : ''}`}
              // mousedown, not click: the input's blur would close the list first.
              onMouseDown={(e) => { e.preventDefault(); pick(s); }}
              onMouseEnter={() => setActive(i)}
            >
              <Avatar username={s.username} name={s.name} size={24} />
              <span className="user-picker__who">
                <span className="user-picker__name">{s.name || s.username}</span>
                <span className="user-picker__username">@{s.username}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
