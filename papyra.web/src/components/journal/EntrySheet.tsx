import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { PapyraEditor, type PapyraEditorRef } from '@lyfie/luthor/presets/papyra';
import '@lyfie/luthor/styles.css';
import { $getRoot, CLEAR_HISTORY_COMMAND, type LexicalEditor } from 'lexical';
import { History, Lock, LockOpen, Maximize2, Minimize2, Trash2 } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import { useFocus } from '../../hooks/useFocus';
import { useToast } from '../../lib/toastContext';
import { useTouchDevice } from '../../hooks/useTouchDevice';
import { useJournalSession } from '../../hooks/useJournalSession';
import { useJournalTemplates, useJournalToday } from '../../hooks/useJournal';
import { expandTemplate, streakWith } from '../../lib/journalTemplates';
import { createPapyraEditorAdapter, OWN_MEDIA } from '../../lib/papyraEditorAdapter';
import { PAPYRA_EDITOR_FEATURES, PAPYRA_EDITOR_THEME, PAPYRA_TOOLBAR_LAYOUT } from '../../lib/editorToolbar';
import { createJournalToolbarItems } from '../../lib/journalToolbar';
import { hasBridgePlaceholder } from '../../lib/bridgePlaceholder';
import { useMediaMetaReady } from '../../lib/mediaMeta';
import { putNote } from '../../lib/notesApi';
import { uuid } from '../../lib/uuid';
import { forgetUnlock, vaultFetch } from '../../lib/vault';
import { promptFor } from '../../lib/journalPrompts';
import { countWords } from '../../lib/journalText';
import { longDate, weekdayName } from '../../lib/journalDay';
import { pauseOffscreenVideos } from '../../lib/videoVisibility';
import { keepMediaToolbarsInView } from '../../lib/mediaToolbarPlacement';
import { useAlwaysShowEditorToolbar } from '../../hooks/useEditorToolbar';
import { useInPlaceWikilinks } from '../../hooks/useInPlaceWikilinks';
import { useReleaseSelectionOnLeave } from '../../hooks/useReleaseSelectionOnLeave';
import { usePlainTableCells } from '../../hooks/usePlainTableCells';
import { useExitBlockShortcut } from '../../hooks/useExitBlockShortcut';
import NoteHistory, { type HistoryVersion, type HistoryView } from '../NoteHistory';
import SecureNoteGate from '../SecureNoteGate';
import MediaDropZone from '../MediaDropZone';
import BusyButton from '../BusyButton';
import GhostCards from '../GhostCards';
import MoodPicker from './MoodPicker';
import type { JournalBridge } from '../../lib/journalBridge';
import { insertTodoEmbed, insertTranscript, insertWikilink } from '../../lib/journalEditorOps';
import { createJournalSlashCommands } from '../../lib/journalSlash';
import { newRefs } from '../../lib/journalMedia';
import { canRecordVoice } from '../../lib/journalVoice';
import { extractMediaRefs } from '../../lib/mediaRefs';
import { loadMediaLimits } from '../../lib/mediaLimits';
import { beginTask } from '../../lib/progress';
import TodoPicker from './TodoPicker';
import VoiceRecorder from './VoiceRecorder';
import PhotoStrip from './PhotoStrip';
import './EntrySheet.css';

const STATUS_LABEL = {
  idle: '',
  saving: 'Saving…',
  saved: 'Saved',
  queued: 'Saved on this device — will sync',
  error: 'Not saved',
} as const;

/**
 * Holds the editor back until the sizes and thumbnails of the day's pictures are known (one batched
 * request), as a note does: an embed drawn before its metadata downloads the full-size original
 * before its thumbnail exists. Mounted per loaded body, so it asks for exactly the pictures the
 * editor opens with.
 */
function MediaReadyGate({ body, children }: { body: string; children: ReactNode }) {
  const ready = useMediaMetaReady(body, OWN_MEDIA);
  return ready ? <>{children}</> : <div className="journal-sheet__skeleton" aria-hidden="true" />;
}

/** Re-serialize after a programmatic load, so luthor's first export is the honest baseline. */
function settleMarkdown(editor: LexicalEditor | null | undefined) {
  editor?.update(() => { $getRoot().markDirty(); }, { discrete: true, tag: 'history-merge' });
}

interface Props {
  date: string;
  /** How the panel beside the page reaches this sheet (link at the caret, carry over). */
  bridge?: JournalBridge;
  /** The page's header chrome (navigation, streak) is drawn by the page; the sheet is the paper. */
  streakLine?: string | null;
}

/**
 * One day of the journal: a sheet of paper with the date at the top, how the
 * day felt, and the page itself. The editor is the same PapyraEditor the notes
 * use — markdown on disk, `[[links]]` to notes, to-dos and other days, photos —
 * minus everything that shares (no live room, no @mentions: a journal is
 * private). A day with nothing written is not a file; the first real words create it.
 */
export default function EntrySheet({ date, streakLine, bridge }: Props) {
  const { theme } = useTheme();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const touch = useTouchDevice();
  const { focus, enter: enterFocus, exit: exitFocus } = useFocus();
  const todayQuery = useJournalToday();
  const prefs = todayQuery.data?.settings;

  const session = useJournalSession(date);
  const { entry, initialBody, editorKey, onText, baseline, flush, readDraft } = session;
  const sheetRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<PapyraEditorRef | null>(null);
  const [lexicalEditor, setLexicalEditor] = useState<LexicalEditor | null>(null);
  const awaitingBaseline = useRef(false);
  // True while History shows a past version: nothing the canvas emits may schedule a save.
  const historyOpen = useRef(false);

  const [pickingTodo, setPickingTodo] = useState(false);
  // A voice note being made: how to put the finished file in the page, given by whatever started it.
  const [voice, setVoice] = useState<{ upload: (file: File) => Promise<void> } | null>(null);
  const [transcribes, setTranscribes] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const locked = !!entry?.locked && !unlocked;
  const readOnly = !!entry && (entry.future || entry.trashed);

  // ── The editor ──────────────────────────────────────────────────────────────
  const alwaysShowToolbar = useAlwaysShowEditorToolbar();
  const [toolbarOverride, setToolbarOverride] = useState<{ scope: string; shown: boolean } | null>(null);
  const toolbarScope = `${date}|${alwaysShowToolbar}`;
  const toolbarShown = toolbarOverride?.scope === toolbarScope ? toolbarOverride.shown : alwaysShowToolbar;
  const canRecord = useMemo(() => canRecordVoice(), []);
  const startVoice = useCallback((upload: (file: File) => Promise<void>) => setVoice({ upload }), []);
  const toolbarItems = useMemo(
    () => createJournalToolbarItems({ recordVoice: canRecord ? startVoice : undefined }),
    [canRecord, startVoice],
  );

  const onUnresolvedLink = useCallback((target: string) => {
    toast(`No note called “${target}”.`, {
      label: 'Create it',
      onClick: () => void (async () => {
        const id = uuid();
        await putNote(id, { title: target, tags: [], color: null, pinned: false, archived: false, kind: 'note', body: '' });
        await queryClient.invalidateQueries({ queryKey: ['notes'] });
        navigate(`/note/${id}`);
      })(),
    });
  }, [toast, queryClient, navigate]);

  const getLiveEditor = useCallback(() => editorRef.current?.getLexicalEditor() ?? null, []);
  // eslint-disable-next-line react-hooks/refs -- called only from the mounted editor's toolbar, never while this renders
  const adapter = useMemo(() => createPapyraEditorAdapter({
    noteId: `journal-${date}`, navigate, queryClient, onUnresolvedLink,
    onUploadError: (message) => toast(message), notify: (message) => toast(message),
    getEditor: getLiveEditor,
    mentions: false, // a private space: @name is plain text
  }), [date, navigate, queryClient, onUnresolvedLink, toast, getLiveEditor]);

  // What `/` adds on a journal page: a journal-only seam of the editor.
  const { setMood, adopt } = session;
  const slashCommands = useMemo(
    () => createJournalSlashCommands({
      day: date, setMood, pickTodo: () => setPickingTodo(true), recordVoice: canRecord ? startVoice : undefined,
    }),
    [date, setMood, canRecord, startVoice],
  );
  // Through a spread, so this builds against a luthor that predates this prop (it then ignores it).
  const journalEditorProps = useMemo(
    () => ({ extraSlashCommands: slashCommands }) as Record<string, unknown>,
    [slashCommands],
  );

  const openLinked = useCallback((target: string) => adapter.openNote({ title: target }), [adapter]);
  useInPlaceWikilinks(sheetRef, openLinked);
  useEffect(() => (sheetRef.current ? pauseOffscreenVideos(sheetRef.current) : undefined), []);
  useEffect(() => (sheetRef.current ? keepMediaToolbarsInView(sheetRef.current) : undefined), []);
  useReleaseSelectionOnLeave(lexicalEditor, sheetRef);

  // Focus mode: the sheet fills the browser (CSS), so while it does it is a modal — Tab stays
  // inside it, and Esc first leaves the writing, then the mode. A menu or panel that owns Esc
  // (the slash menu, the to-do picker, the voice bar) gets it first.
  useEffect(() => {
    if (!focus) return;
    const onKey = (e: KeyboardEvent) => {
      const node = sheetRef.current;
      if (!node) return;
      if (e.key === 'Escape') {
        if (e.defaultPrevented || document.querySelector('.luthor-slash-menu, .luthor-mention-menu, .todo-picker, .voice-recorder')) return;
        const active = document.activeElement as HTMLElement | null;
        if (active?.closest('.luthor-content-editable')) active.blur(); else exitFocus();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = [...node.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]',
      )].filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      const inside = !!active && node.contains(active);
      // Inside the writing Tab indents; the trap only catches focus at the edges, or outside.
      if (!inside) { e.preventDefault(); items[0].focus(); }
      else if (!e.shiftKey && active === items[items.length - 1]) { e.preventDefault(); items[0].focus(); }
      else if (e.shiftKey && active === items[0]) { e.preventDefault(); items[items.length - 1].focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focus, exitFocus]);
  usePlainTableCells(lexicalEditor);
  useExitBlockShortcut(lexicalEditor);

  const onEditorChange = useCallback(({ markdown, source }: { markdown: string; source: 'user' | 'programmatic' | 'remote' }) => {
    if (source !== 'user' || historyOpen.current) return;
    if (awaitingBaseline.current) {
      awaitingBaseline.current = false;
      if (!hasBridgePlaceholder(markdown)) { baseline(markdown); return; }
    }
    onText(markdown);
  }, [baseline, onText]);

  // ── History ─────────────────────────────────────────────────────────────────
  const [history, setHistory] = useState(false);
  const [historyView, setHistoryView] = useState<HistoryView>('preview');
  const [historyLive, setHistoryLive] = useState<HistoryVersion>({ title: date, body: '' });
  const [diffSlot, setDiffSlot] = useState<HTMLDivElement | null>(null);

  async function openHistory() {
    await flush();
    setHistoryLive({ title: date, body: readDraft() });
    historyOpen.current = true;
    setHistory(true);
    editorRef.current?.getLexicalEditor()?.setEditable(false);
  }
  const previewVersion = useCallback((version: HistoryVersion | null) => {
    editorRef.current?.setMarkdown(version ? version.body : readDraft());
    settleMarkdown(editorRef.current?.getLexicalEditor());
  }, [readDraft]);
  const leaveHistory = useCallback(() => {
    historyOpen.current = false;
    setHistory(false);
    const lexical = editorRef.current?.getLexicalEditor();
    editorRef.current?.setMarkdown(readDraft());
    settleMarkdown(lexical);
    // Each previewed version was an undo step; undoing into one would autosave it over the day.
    lexical?.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
    lexical?.setEditable(!readOnly);
  }, [readDraft, readOnly]);

  const postRestore = useCallback(async (snapshotId: string): Promise<string | null> => {
    const res = await vaultFetch(`/api/notes/journal-${date}/restore/${encodeURIComponent(snapshotId)}`, { method: 'POST' });
    if (!res.ok) throw new Error(`POST restore failed: ${res.status}`);
    const restored = (await res.json()) as { body: string };
    historyOpen.current = false;
    setHistory(false);
    session.adopt(restored.body, null);
    return res.headers.get('Papyra-Undo-Snapshot');
  }, [date, session]);

  const restoreVersion = useCallback(async (snapshotId: string, label: string) => {
    const undoId = await postRestore(snapshotId);
    toast(`Restored the version from ${label}.`, undoId ? {
      label: 'Undo',
      onClick: () => void postRestore(undoId).then(() => toast('Restore undone.'), () => toast('Couldn’t undo the restore.')),
    } : undefined);
  }, [postRestore, toast]);

  // ── Lock ────────────────────────────────────────────────────────────────────
  // Not through the autosave path: a refusal here is an answer ("set a PIN", "open the vault"),
  // not an outage, and it must never sit in the offline queue retrying.
  async function setLock(next: boolean) {
    await flush();
    let res: Response;
    try {
      res = await vaultFetch(`/api/journal/${date}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secure: next }),
      });
    } catch {
      toast('Couldn’t change the lock — the server is unreachable.');
      return;
    }
    if (res.status === 409) {
      toast('Set a vault PIN before locking a day.', { label: 'Set PIN', onClick: () => navigate('/settings?tab=security&s=vault-pin') });
      return;
    }
    if (res.status === 401) { forgetUnlock(); setUnlocked(false); return; } // the vault lapsed: ask for the PIN again
    if (!res.ok) { toast('Couldn’t change the lock.'); return; }
    setUnlocked(false);
    await session.reload();
    void queryClient.invalidateQueries({ queryKey: ['journal'] });
    toast(next ? 'Locked. It opens with your vault PIN.' : 'The lock is off.');
  }

  // ── Trash ───────────────────────────────────────────────────────────────────
  async function restoreFromTrash() {
    const res = await fetch(`/api/notes/journal-${date}/untrash`, { method: 'POST' });
    if (!res.ok) { toast('Couldn’t restore this day.'); return; }
    await session.reload();
    void queryClient.invalidateQueries({ queryKey: ['journal'] });
  }

  async function moveToTrash() {
    await flush();
    const res = await fetch(`/api/notes/journal-${date}/trash`, { method: 'POST' });
    if (!res.ok) { toast('Couldn’t move this day to the Trash.'); return; }
    void queryClient.invalidateQueries({ queryKey: ['journal'] });
    toast('Moved to the Trash.', {
      label: 'Undo',
      onClick: () => void fetch(`/api/notes/journal-${date}/untrash`, { method: 'POST' })
        .then(() => { void session.reload(); void queryClient.invalidateQueries({ queryKey: ['journal'] }); }),
    });
    await session.reload();
  }

  // ── Starting from a template ────────────────────────────────────────────────
  const templates = useJournalTemplates();
  const startable = !!entry && !entry.exists && !entry.future && !readOnly && !locked && !history;
  const offered = useMemo(() => {
    const list = templates.data?.templates ?? [];
    const first = templates.data?.defaultTemplate;
    return first ? [...list.filter((t) => t.name === first), ...list.filter((t) => t.name !== first)] : list;
  }, [templates.data]);
  const startFrom = useCallback((name: string) => {
    const template = offered.find((t) => t.name === name);
    if (!template) return;
    const text = expandTemplate(template.body, { day: date, streak: streakWith(todayQuery.data?.stats, entry?.today === date) });
    // The page is the template's text, unsaved: the day exists once there are words of its own.
    adopt(text, undefined, { quiet: true });
  }, [offered, date, todayQuery.data?.stats, entry?.today, adopt]);

  // ── Words for the footer, pictures for the strip ────────────────────────────
  const [words, setWords] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  useEffect(() => {
    const t = setTimeout(() => { const md = readDraft(); setWords(countWords(md)); setDraft(md); }, 400);
    return () => clearTimeout(t);
  }, [session.status, initialBody, editorKey, readDraft]);

  // ── Voice notes ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!voice) return;
    let alive = true;
    void loadMediaLimits().then((table) => { if (alive) setTranscribes(!!table?.transcription); });
    return () => { alive = false; };
  }, [voice]);

  // Transcripts in flight, stopped when the day is left (the words stay one click away on the player).
  const watching = useRef(new Set<AbortController>());
  useEffect(() => {
    const set = watching.current;
    return () => { set.forEach((c) => c.abort()); set.clear(); };
  }, [date]);

  /** Wait for the server to read a recording, then write what it says under the player. */
  const watchTranscript = useCallback((name: string) => {
    const control = new AbortController();
    watching.current.add(control);
    const task = beginTask({ label: 'Writing out your voice note' });
    void (async () => {
      try {
        for (let tries = 0; tries < 300 && !control.signal.aborted; tries++) {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 3000);
            control.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
          });
          if (control.signal.aborted) return;
          const res = await fetch(`/api/media/${encodeURIComponent(name)}/text`, { credentials: 'same-origin', signal: control.signal });
          if (!res.ok) continue;
          const { text } = (await res.json()) as { text?: string };
          const editor = getLiveEditor();
          if (text && editor) insertTranscript(editor, name, text);
          return;
        }
      } catch { /* aborted, or the network went: the words stay on the player */ } finally {
        task.end();
        watching.current.delete(control);
      }
    })();
  }, [getLiveEditor]);

  /** Put a recording in the page; a WAV (made when the server can transcribe) is followed to its words. */
  const addRecording = useCallback(async (file: File) => {
    if (!voice) return;
    const before = extractMediaRefs(editorRef.current?.getMarkdown());
    await voice.upload(file);
    if (!file.name.toLowerCase().endsWith('.wav')) return;
    const added = newRefs(before, editorRef.current?.getMarkdown()).find((n) => n.toLowerCase().endsWith('.wav'));
    if (added) watchTranscript(added);
  }, [voice, watchTranscript]);

  // ── The panel beside the page ───────────────────────────────────────────────
  const carryOver = useCallback(async (): Promise<number> => {
    await flush();
    const res = await fetch(`/api/journal/${date}/carry-over`, { method: 'POST' });
    if (!res.ok) throw new Error(`carry-over failed: ${res.status}`);
    const carried = Number(res.headers.get('X-Papyra-Carried') ?? 0);
    if (carried > 0) {
      const next = (await res.json()) as { body: string };
      adopt(next.body, res.headers.get('ETag'));
    }
    return carried;
  }, [date, flush, adopt]);
  useEffect(() => {
    if (!bridge || !entry || locked || readOnly || history) return;
    bridge.attach({
      insertLink: (target) => { const editor = getLiveEditor(); if (editor) insertWikilink(editor, target); },
      insertTodo: (title) => { const editor = getLiveEditor(); if (editor) insertTodoEmbed(editor, title); },
      carryOver,
    });
    return () => bridge.detach();
  }, [bridge, entry, locked, readOnly, history, getLiveEditor, carryOver]);
  // The panel reads what the page says (links), a beat after typing settles.
  useEffect(() => {
    if (!bridge) return;
    const t = setTimeout(() => bridge.setDraft(readDraft()), 400);
    return () => clearTimeout(t);
  }, [bridge, session.status, initialBody, editorKey, readDraft]);

  const placeholder = prefs?.promptsOn === false ? 'Start writing…' : promptFor(date);
  const day = entry?.date ?? date;

  if (!entry && !session.loadError) {
    return (
      <article className="journal-sheet journal-sheet--loading" aria-busy="true" aria-label={`Journal, ${longDate(date)}`}>
        <div className="journal-sheet__skeleton" aria-hidden="true" />
      </article>
    );
  }
  if (session.loadError && !entry) {
    return (
      <article className="journal-sheet" aria-label="Journal">
        <p className="journal-sheet__notice journal-sheet__notice--error" role="alert">
          Couldn’t open this day. <button type="button" className="journal-sheet__link" onClick={() => void session.reload()}>Try again</button>
        </p>
      </article>
    );
  }

  const isToday = entry?.today === date;

  return (
    <article
      ref={sheetRef}
      className={`journal-sheet${focus ? ' journal-sheet--focus' : ''}${isToday ? ' journal-sheet--today' : ''}`}
      aria-label={`Journal, ${longDate(day)}`}
      role={focus ? 'dialog' : undefined}
      aria-modal={focus || undefined}
    >
      {isToday && <span className="journal-sheet__ribbon" aria-hidden="true" />}

      <header className="journal-sheet__head">
        <div className="journal-sheet__titles">
          <p className="journal-sheet__weekday">{weekdayName(day)}</p>
          {/* The date opens the calendar, on this day's month. */}
          <h1 className="journal-sheet__date">
            <Link to={`/journal/calendar?m=${day.slice(0, 7)}`} className="journal-sheet__date-link" title="Open the calendar">
              {longDate(day)}
            </Link>
          </h1>
          {streakLine && !focus && <p className="journal-sheet__streak">{streakLine}</p>}
        </div>
        {focus ? (
          <button type="button" className="journal-sheet__exit" onClick={exitFocus}>
            <Minimize2 size={14} aria-hidden="true" /> Exit focus
          </button>
        ) : (
          <div className="journal-sheet__mood">
            <MoodPicker
              collapsible
              compact
              value={entry?.mood ?? null}
              onChange={session.setMood}
              disabled={!entry || entry.future || entry.trashed}
            />
          </div>
        )}
      </header>

      {entry?.trashed && (
        <div className="journal-sheet__notice" role="status">
          <Trash2 size={15} aria-hidden="true" />
          <span>This day is in the Trash.</span>
          <BusyButton type="button" className="journal-sheet__action" busyLabel="Restoring…" onClick={restoreFromTrash}>Restore</BusyButton>
        </div>
      )}
      {entry?.future && (
        <p className="journal-sheet__notice" role="status">This day hasn’t begun. You can write on it when it does.</p>
      )}
      {session.conflict && (
        <div className="journal-sheet__notice journal-sheet__notice--warn" role="alert">
          <span>This day was changed on another device while you were writing.</span>
          <span className="journal-sheet__notice-actions">
            <button type="button" className="journal-sheet__action" onClick={session.takeTheirs}>Use the newer version</button>
            <BusyButton type="button" className="journal-sheet__action" busyLabel="Saving…" onClick={session.keepMine}>Keep what I wrote</BusyButton>
          </span>
        </div>
      )}
      {session.error && !session.conflict && (
        <p className="journal-sheet__notice journal-sheet__notice--error" role="alert">{session.error}</p>
      )}

      {startable && offered.length > 0 && !initialBody.trim() && !draft.trim() && (
        <div className="journal-sheet__starts" role="group" aria-label="Start from a template">
          <span className="journal-sheet__starts-label">Start from</span>
          {offered.map((t) => (
            <button key={t.name} type="button" className="journal-sheet__chip" onClick={() => startFrom(t.name)}>{t.name}</button>
          ))}
        </div>
      )}

      {history && (
        <NoteHistory
          noteId={`journal-${date}`}
          live={historyLive}
          onPreview={previewVersion}
          onRestore={restoreVersion}
          onClose={leaveHistory}
          view={historyView}
          onViewChange={setHistoryView}
          diffSlot={diffSlot}
        />
      )}

      <div ref={scrollRef} className="journal-sheet__body">
        {history && <div ref={setDiffSlot} className="journal-sheet__diff-slot" />}
        {locked ? (
          <SecureNoteGate
            noun="day"
            noteId={`journal-${date}`}
            onUnlocked={(body) => { setUnlocked(true); session.adopt(body, null); }}
          />
        ) : (
          <div className="journal-sheet__canvas">
            <MediaReadyGate key={`${date}-${editorKey}`} body={initialBody}>
            <PapyraEditor
              featureFlags={PAPYRA_EDITOR_FEATURES}
              theme={PAPYRA_EDITOR_THEME}
              key={`${date}-${editorKey}-${readOnly ? 'ro' : 'rw'}`}
              readOnly={readOnly}
              {...journalEditorProps}
              initialTheme={theme}
              toolbar={toolbarShown && !history && !readOnly && !focus}
              toolbarAlignment="center"
              toolbarLayout={PAPYRA_TOOLBAR_LAYOUT}
              toolbarItems={toolbarItems}
              defaultEditorView="visual"
              blockAnchors="off"
              defaultContent={initialBody}
              placeholder={readOnly ? '' : placeholder}
              adapter={adapter}
              onChange={onEditorChange}
              onDesync={(info) => console.warn('[papyra] editor DOM diverged from model', info)}
              onReady={(methods) => {
                editorRef.current = methods;
                const lexical = methods.getLexicalEditor();
                setLexicalEditor(lexical ?? null);
                lexical?.getRootElement()?.setAttribute('aria-label', 'Journal entry');
                // defaultContent loads as plain text; parse the markdown into the visual surface.
                methods.setMarkdown(initialBody);
                lexical?.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
                const read = methods.getMarkdown();
                awaitingBaseline.current = hasBridgePlaceholder(read);
                if (!awaitingBaseline.current) baseline(read);
                // Straight into the page, caret at the end — except where that would only
                // throw up a phone's keyboard, or take focus from something being used.
                const active = document.activeElement;
                const idle = !active || active === document.body || sheetRef.current?.contains(active);
                if (!readOnly && !touch && idle) {
                  setTimeout(() => {
                    lexical?.focus(() => {
                      // Lexical places the caret; make sure the page itself follows it.
                      const root = lexical.getRootElement();
                      if (root && document.activeElement !== root) root.focus({ preventScroll: true });
                    }, { defaultSelection: 'rootEnd' });
                  }, 0);
                }
              }}
            />
            </MediaReadyGate>
          </div>
        )}
      </div>

      {!locked && !history && !readOnly && <MediaDropZone editor={lexicalEditor} sheetRef={sheetRef} />}

      {pickingTodo && (
        <TodoPicker
          onClose={() => { setPickingTodo(false); getLiveEditor()?.focus(); }}
          onPick={(title) => { setPickingTodo(false); const editor = getLiveEditor(); if (editor) insertTodoEmbed(editor, title); }}
        />
      )}

      {!locked && !history && <GhostCards noteId={`journal-${date}`} />}

      {voice && !locked && !history && !readOnly && (
        <VoiceRecorder day={date} transcribe={transcribes} onFile={addRecording} onClose={() => { setVoice(null); getLiveEditor()?.focus(); }} />
      )}

      {!locked && !history && <PhotoStrip markdown={draft} root={() => lexicalEditor?.getRootElement() ?? null} />}

      {!focus && (
      <footer className="journal-sheet__foot">
        <div className="journal-sheet__foot-left">
          {words !== null && !locked && (
            <span className="journal-sheet__words">{words} {words === 1 ? 'word' : 'words'}</span>
          )}
        </div>
        <div className="journal-sheet__foot-right">
          <span className={`journal-sheet__status journal-sheet__status--${session.status}`} role="status" aria-live="polite">
            {STATUS_LABEL[session.status]}
          </span>
          <button
            type="button" className="journal-sheet__tool"
            onClick={() => setToolbarOverride({ scope: toolbarScope, shown: !toolbarShown })}
            aria-pressed={toolbarShown} disabled={readOnly || locked}
          >Format</button>
          {entry?.exists && !entry.trashed && !readOnly && !history && (!entry.locked || unlocked) && (
            <BusyButton
              type="button" className="journal-sheet__tool" busyLabel={entry.locked ? 'Unlocking…' : 'Locking…'}
              onClick={() => setLock(!entry.locked)}
              title={entry.locked ? 'Take the lock off this day' : 'Lock this day with your vault PIN'}
            >
              {entry.locked ? <LockOpen size={14} aria-hidden="true" /> : <Lock size={14} aria-hidden="true" />}
              {entry.locked ? ' Remove lock' : ' Lock'}
            </BusyButton>
          )}
          <button
            type="button" className="journal-sheet__tool"
            onClick={() => (history ? leaveHistory() : void openHistory())}
            aria-pressed={history} disabled={!entry?.exists || locked}
            title="Earlier versions of this day"
          ><History size={14} aria-hidden="true" /> History</button>
          {entry?.exists && !entry.trashed && !locked && (
            <button type="button" className="journal-sheet__tool" onClick={() => void moveToTrash()} title="Move this day to the Trash">
              <Trash2 size={14} aria-hidden="true" /> Trash
            </button>
          )}
          <button
            type="button" className="journal-sheet__tool"
            onClick={() => (focus ? exitFocus() : enterFocus())}
            aria-pressed={focus} title={focus ? 'Leave focus mode' : 'Focus mode'}
          >
            {focus ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}
            {focus ? ' Exit focus' : ' Focus'}
          </button>
        </div>
      </footer>
      )}
    </article>
  );
}
