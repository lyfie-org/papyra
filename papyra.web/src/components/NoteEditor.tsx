import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { PapyraEditor, type PapyraEditorRef } from '@lyfie/luthor/presets/papyra';
import '@lyfie/luthor/styles.css';
import { LexicalCollaboration } from '@lexical/react/LexicalCollaborationContext';
import { $getRoot, CLEAR_HISTORY_COMMAND, type LexicalEditor } from 'lexical';
import { hasBridgePlaceholder } from '../lib/bridgePlaceholder';
import type { Note } from '../types/note';
import { useAutoSave, type Draft } from '../hooks/useAutoSave';
import { useTheme } from '../hooks/useTheme';
import { createPapyraEditorAdapter } from '../lib/papyraEditorAdapter';
import { tintInkClass } from '../lib/noteColors';
import { PAPYRA_TOOLBAR_LAYOUT, createToolbarItems } from '../lib/editorToolbar';
import { putNote } from '../lib/notesApi';
import { patchNoteInCache } from '../lib/notesCache';
import { patchDraft } from '../lib/noteDrafts';
import { vaultFetch } from '../lib/vault';
import VaultUnlock from './VaultUnlock';
import { closeTarget } from '../lib/noteLink';
import { useToast } from '../lib/toastContext';
import { useMentionShare } from '../hooks/useMentionShare';
import { useInPlaceWikilinks } from '../hooks/useInPlaceWikilinks';
import { useTrashNote } from '../hooks/useTrashNote';
import NoteToolbar from './NoteToolbar';
import TagEditor from './TagEditor';
import GhostCards from './GhostCards';
import NoteHistory, { type HistoryVersion, type HistoryView } from './NoteHistory';
import NoteToc from './NoteToc';
import SecureNoteGate from './SecureNoteGate';
import ShareDialog from './ShareDialog';
import { Minimize2, RefreshCw, Volume2, VolumeX } from 'lucide-react';
import { useFocus } from '../hooks/useFocus';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { useAmbient } from '../hooks/useAmbient';
import { useAlwaysShowEditorToolbar } from '../hooks/useEditorToolbar';
import './NoteEditor.css';
import { editedLabel, fullStamp, useMinuteTick, useTimeZone } from '../lib/timeZone';
import LinkCards from './LinkCards';
import LinkHoverCard from './LinkHoverCard';
import MediaTools from './MediaTools';
import LoadingBar from './LoadingBar';
import CollabPresence from './CollabPresence';
import { useShareSummary } from '../hooks/useShares';
import { useCollabRoom } from '../hooks/useCollabRoom';
import { useCollabCursorLabels } from '../hooks/useCollabCursorLabels';
import { COLLAB_HEADER } from '../lib/notesApi';

/*
 * luthor ≤2.9.7 serializes a just-adopted document without the Papyra preset's
 * bridge extras, so until the next commit getMarkdown() returns
 * `[Unsupported blockAnchor preserved in markdown metadata]` where every `^id`
 * (and wikilink, and embed) should be. Papyra baselined autosave on that, so the
 * first real serialization after opening looked like an edit: an untouched note
 * was re-saved on open — re-dated to the top of its list, and if Delete was
 * clicked first, the late save pulled it straight back out of Trash. A read in
 * that window (a pin or tag save) could even have written the placeholder text
 * to disk. Fixed at the source in luthor (hydrateSourceSnapshots); these guards
 * (see lib/bridgePlaceholder) make Papyra safe on any version.
 */
/**
 * After a setMarkdown on a mounted editor, force luthor to re-serialize (a no-op
 * dirtying update marks its canonical markdown stale). Only effective once the
 * editor's own listeners are attached — i.e. not inside onReady.
 */
function settleMarkdown(editor: LexicalEditor | null | undefined) {
  editor?.update(() => { $getRoot().markDirty(); }, { discrete: true, tag: 'history-merge' });
}

/** Drop the undo stack — for content the host put there, which the user never typed. */
function forgetHistory(editor: LexicalEditor | null | undefined) {
  editor?.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
}

const STATUS_LABEL = {
  idle: '',
  saving: 'Saving…',
  saved: 'Saved to local disk',
  queued: 'Saved on this device — will sync',
} as const;

/** "Edited 3:42 PM", in the person's time zone; the full date on hover. */
function EditedStamp({ updated }: { updated: string }) {
  const zone = useTimeZone();
  const now = useMinuteTick();
  const label = editedLabel(updated, zone, now);
  if (!label) return null;
  return (
    <time className="note-editor__edited" dateTime={updated} title={fullStamp(updated, zone)}>
      {label}
    </time>
  );
}

// The editing canvas for a single note. Luthor's markdown preset owns the body
// (uncontrolled — content is read imperatively at save time); a Marcellus title
// input sits above it. Both feed the debounced auto-save.
/**
 * `isDraft`: a new note not yet on the server (see lib/noteDrafts). Its first
 * change saves it like any other edit; closed untouched, nothing is written.
 */
export default function NoteEditor({ note, isDraft = false }: { note: Note; isDraft?: boolean }) {
  const { theme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  // The list the note was opened from, so closing returns there rather than
  // always dropping the user on Notes.
  const closeTo = closeTarget(location);
  const queryClient = useQueryClient();
  const editorRef = useRef<PapyraEditorRef | null>(null);
  // The scrolling editor panel — the ghost TOC measures heading offsets against it.
  // The sheet (dialog shell) and its scroll area are separate elements: the
  // footer and history bar sit outside the scroll area, so their rules run the
  // full width of the sheet instead of stopping short at the scrollbar.
  const sheetRef = useRef<HTMLElement>(null);
  const editorScrollRef = useRef<HTMLDivElement>(null);
  const [diffSlot, setDiffSlot] = useState<HTMLDivElement | null>(null);
  // Distraction-free focus mode (shared with the SignalR bridge, which buffers
  // updates while focused). Aliased to avoid clashing with the conflict-banner
  // `pending` state below.
  const { focus, pending: pendingUpdates, enter: enterFocus, exit: exitFocus, flush: flushUpdates } = useFocus();
  const ambient = useAmbient();
  // The formatting toolbar above the body. Each note opens with the Settings
  // preference ("always show"), and the footer toggle overrides it for the note
  // in hand. It is a live editor prop — showing or hiding it never remounts the
  // editor, so the caret and undo history survive.
  // The toggle is an override scoped to this note and this preference value, so
  // opening another note, or changing the preference, falls back to the preference.
  const alwaysShowToolbar = useAlwaysShowEditorToolbar();
  const toolbarScope = `${note.id}|${alwaysShowToolbar}`;
  const [toolbarOverride, setToolbarOverride] = useState<{ scope: string; shown: boolean } | null>(null);
  const toolbarShown = toolbarOverride?.scope === toolbarScope ? toolbarOverride.shown : alwaysShowToolbar;
  // Trashing a note is the same decision here as it is on a card, so both go
  // through one rule — see useTrashNote for what drifted when they did not.
  const trashNote = useTrashNote();

  // A `[[link]]` naming no note we hold. Every wikilink renders the same whether
  // or not it resolves, so a click on a dead one used to do nothing and say
  // nothing. Say what happened, and offer the obvious next step.
  const onUnresolvedLink = useCallback((target: string) => {
    toast(`No note called “${target}”.`, {
      label: 'Create it',
      onClick: () => void (async () => {
        const id = crypto.randomUUID();
        await putNote(id, {
          title: target, tags: [], color: null, pinned: false, archived: false, kind: 'note', body: '',
        });
        await queryClient.invalidateQueries({ queryKey: ['notes'] });
        navigate(`/note/${id}`);
      })(),
    });
  }, [toast, queryClient, navigate]);

  // The host seam: media GET/upload → /api/media, [[ search → notes cache,
  // wikilink activation → router push. Rebuilt only when the open note or the
  // injected services change. The editor owns the drop/paste upload pipeline
  // through adapter.uploadMedia, so Papyra no longer hand-splices ![[…]].
  // Papyra's own toolbar items (icons, grouping and inserts are ours; luthor
  // supplies the controls). Upload failures surface as a toast.
  const toolbarItems = useMemo(() => createToolbarItems((message) => toast(message)), [toast]);
  const adapter = useMemo(() => {
    const base = createPapyraEditorAdapter({ noteId: note.id, navigate, queryClient, onUnresolvedLink });
    return {
      ...base,
      // An attachment that can't be stored (too big for its kind, offline)
      // says so, instead of the drop silently doing nothing.
      uploadMedia: async (file: File) => {
        try { return await base.uploadMedia(file); }
        catch (err) { toast(err instanceof Error ? err.message : 'Couldn’t attach that file.'); throw err; }
      },
    };
  }, [note.id, navigate, queryClient, onUnresolvedLink, toast]);
  // A [[link]] replaces the open note in place — never a second browser tab.
  const openLinkedNote = useCallback((target: string) => adapter.openNote({ title: target }), [adapter]);
  useInPlaceWikilinks(sheetRef, openLinkedNote);
  // The live Lexical editor, for tools that work on it from outside luthor.
  const [lexicalEditor, setLexicalEditor] = useState<LexicalEditor | null>(null);
  // luthor's own image paths (the /image slash command) otherwise fall back to
  // a blob: URL, which dies on reload. Store the file like any other upload and
  // point the image at the media route.
  const imageUploadHandler = useCallback(async (file: File) => {
    const { filename } = await adapter.uploadMedia(file);
    return adapter.resolveMediaUrl(filename);
  }, [adapter]);
  const [title, setTitle] = useState(note.title);
  // Mirror the title in a ref so the debounced save reads the live value, not a
  // value captured in the closure of the render that scheduled it.
  const titleRef = useRef(note.title);
  // The body Luthor is mounted with. Luthor is uncontrolled (defaultContent only
  // applies on mount), so adopting a remote body means remounting with a fresh
  // key — never patching the live DOM, which would hijack the caret.
  const [body, setBody] = useState(note.body);
  const [editorKey, setEditorKey] = useState(0);
  // Latest markdown seen from the live editor, kept current on every input. Lets
  // a flush on close/unmount read the draft even after Luthor's ref tears down.
  const latestBody = useRef(note.body);

  // True while history shows a past version: autosave is off and the canvas is
  // not the draft (see getDraft and NoteHistory).
  const suppressSave = useRef(false);

  // ── Live editing ─────────────────────────────────────────────────────────
  // A note shared with at least one person opens in its live room (the
  // embedded collab engine): everyone's carets, no lost edits. Unshared notes
  // keep the classic autosave editor and never depend on the engine. Once live
  // for this note, it stays live until closed — dropping back mid-session
  // would remount on a body the room may not have saved yet.
  const shareSummary = useShareSummary();
  const sharedWithPeople = !!shareSummary.data?.some((s) => s.noteId === note.id && s.people.length > 0);
  const collabEligible = !isDraft && !note.secure && note.kind !== 'inbox';
  const [collabLatch, setCollabLatch] = useState<string | null>(null);
  if (collabEligible && sharedWithPeople && collabLatch !== note.id) setCollabLatch(note.id);
  const collabOn = collabEligible && (sharedWithPeople || collabLatch === note.id);
  // Joined only after the classic draft is flushed (see the effect below), so
  // the room seeds from the latest text.
  const [joinedId, setJoinedId] = useState<string | null>(null);
  // The room owns the body while this is true: saves send metadata only, and
  // the editor's own changes never schedule an autosave. Mirrored into a ref
  // for the save paths, which read it at write time.
  const collabRef = useRef(false);
  const cursorsRef = useRef<HTMLDivElement>(null);
  const isCollab = useCallback(() => collabRef.current, []);

  // Read the live draft on demand: title from the ref, body from Luthor's ref
  // (falling back to the last value mirrored on input when the ref is gone).
  //
  // While history is open the canvas holds a *past* version, not the draft. Every
  // writer reads the draft through here — tag/pin/colour/archive/lock saves, the
  // unmount flush — so this is where a preview is kept from ever being mistaken
  // for the note: the live body is the one mirrored before history opened.
  //
  // Nor may placeholder text (see hasBridgePlaceholder) ever reach a writer:
  // then the last good body mirrored from the editor stands in.
  const getDraft = useCallback((): Draft => {
    // Live: the body on disk is the room's; ours is only a placeholder the
    // server ignores (see COLLAB_HEADER), held steady so it never reads dirty.
    if (suppressSave.current || collabRef.current) return { title: titleRef.current, body: latestBody.current };
    const md = editorRef.current?.getMarkdown();
    return {
      title: titleRef.current,
      body: md === undefined || hasBridgePlaceholder(md) ? latestBody.current : md,
    };
  }, []);

  // Set when the editor opened on a placeholder serialization: the next
  // luthor-reported change is its first honest serialization of the note just
  // loaded — the baseline — not something the person typed.
  const awaitingBaseline = useRef(false);

  // A `secure: true` note arrives with an empty body — the API withholds it until a
  // biometric unlock. Until then the canvas is replaced by the gate, so the editor
  // can never autosave an empty body over the real (locked) content on disk.
  const [unlocked, setUnlocked] = useState(false);
  const isLocked = !!note.secure && !unlocked;

  // The write path's draft — the text as written. Saves used to stamp a hidden
  // `^id` anchor onto every paragraph and heading (ensureBlockAnchors), so any
  // block could be embedded elsewhere; nothing in the app ever made such a link,
  // and the anchors cluttered the end of nearly every line of every .md file
  // and export. Anchors already in a note are kept as written (luthor "off"
  // mode round-trips them) and the server's daily "Tidy block markers" job
  // removes the ones nothing points at.
  const getSaveDraft = getDraft;

  // Naming someone in a note offers to share the note with them — see
  // useMentionShare for why it asks rather than acts.
  const getTitle = useCallback(() => titleRef.current, []);
  const offerMentionShare = useMentionShare(note.id, note.secure, getTitle);
  const onSaved = useCallback(
    (priorBody: string, nextBody: string) => { void offerMentionShare(priorBody, nextBody); },
    [offerMentionShare],
  );

  const { status, isDirty, bump, reset, flush, savedRef } = useAutoSave(note, getDraft, getSaveDraft, onSaved, isCollab);
  // Keyboard users land inside the editor instead of at the top of the page.
  useDialogFocus(sheetRef);

  // Sharing from inside the open note — the same dialog the card opens.
  const [shareOpen, setShareOpen] = useState(false);

  // History mode (NoteHistory): a timeline bar over the note, with past versions
  // shown read-only in the canvas. While open, autosave is hard-disabled
  // (suppressSave) so previewing a version never overwrites the live file — only
  // an explicit "Restore this version" writes to disk.
  const [history, setHistory] = useState(false);
  const [historyView, setHistoryView] = useState<HistoryView>('preview');
  // The live note as it was on entering history — the "Now" end of the timeline.
  const [historyLive, setHistoryLive] = useState<HistoryVersion>({ title: note.title, body: note.body });
  // A previewed version's title, shown in the (read-only) title field.
  const [previewTitle, setPreviewTitle] = useState<string | null>(null);
  // Asking for the vault PIN before a lock can come off (see toggleSecure).
  const [unlockToChangeLock, setUnlockToChangeLock] = useState(false);

  // Going live: save the classic draft first (a plain body write — the room
  // isn't ours yet), then join. The fallback editor (engine off) remounts on
  // that same saved text.
  useEffect(() => {
    if (!collabOn) return;
    let cancelled = false;
    void flush().then(() => {
      if (cancelled) return;
      setBody(latestBody.current);
      setJoinedId(note.id);
    });
    return () => { cancelled = true; };
  }, [collabOn, note.id, flush]);
  // History reads past versions in a classic, read-only canvas, so the room is
  // left while it is open and rejoined after.
  const room = useCollabRoom(
    collabOn && joinedId === note.id && !history ? { noteId: note.id } : null,
    cursorsRef,
  );
  // Live mode, unless the engine said it is off (then: classic autosave).
  const [collabDownFor, setCollabDownFor] = useState<string | null>(null);
  if (room.status === 'unavailable' && collabDownFor !== note.id) setCollabDownFor(note.id);
  const collabLive = collabOn && collabDownFor !== note.id;
  const collabActive = collabLive && joinedId === note.id;
  const liveEditorKey = collabLive && !history && room.collaboration
    ? `${room.generation}-${theme}-${note.color ?? ''}` : null;
  useCollabCursorLabels(cursorsRef, liveEditorKey);
  // Read-only until the room has delivered the note, and again while offline
  // for a viewer; typing into an unsynced doc would land beside the note.
  useEffect(() => {
    if (liveEditorKey && lexicalEditor) lexicalEditor.setEditable(room.synced);
  }, [liveEditorKey, lexicalEditor, room.synced]);
  useEffect(() => { collabRef.current = collabActive; }, [collabActive]);

  // What the editor currently displays — the yardstick for detecting that the
  // server snapshot (refreshed by SignalR invalidation) carries a new revision.
  const shown = useRef({ id: note.id, title: note.title, body: note.body });
  // A remote revision held back because the local draft is dirty (caret guard).
  const [pending, setPending] = useState<{ title: string; body: string } | null>(null);
  // A remote revision that arrived while history was open. The canvas is showing
  // a past version then, so it can neither be adopted (the remount would drop the
  // read-only preview) nor judged against the draft (the "draft" is the preview,
  // which would read as unsaved edits and raise a false conflict). Applied on leave.
  const deferredRemote = useRef<{ title: string; body: string } | null>(null);
  // Where focus was when a remote adopt remounted the canvas (see applyRemote).
  const focusToRestore = useRef<{ el: HTMLElement; start: number | null; end: number | null } | null>(null);

  // Force the editor to display a remote revision, re-baselining the save state
  // so the adopted content isn't immediately written back.
  const applyRemote = useCallback((next: { title: string; body: string }) => {
    // Adopting remounts the canvas, and loading markdown into a fresh Lexical
    // editor moves the DOM selection — and with it the focus — into the body.
    // That is how a new note's first save (its echo can differ from what was
    // sent, e.g. whitespace the file drops) pulled the caret out of the title
    // mid-word. Remember where focus was; onReady puts it back.
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body && !active.closest('.note-editor__canvas')) {
      const field = active as HTMLInputElement;
      focusToRestore.current = {
        el: active,
        start: typeof field.selectionStart === 'number' ? field.selectionStart : null,
        end: typeof field.selectionEnd === 'number' ? field.selectionEnd : null,
      };
    }
    titleRef.current = next.title;
    latestBody.current = next.body;
    setTitle(next.title);
    setBody(next.body);
    setEditorKey((k) => k + 1);
    reset(next);
    shown.current = { id: note.id, ...next };
    setPending(null);
  }, [reset, note.id]);

  // Leave history without restoring: put the live note back in an editable
  // canvas, forget the preview undo steps, and re-enable saving.
  const leaveHistory = useCallback(() => {
    suppressSave.current = false;
    setPreviewTitle(null);
    setHistory(false);
    const remote = deferredRemote.current;
    deferredRemote.current = null;
    // Live: the preview canvas unmounts and the room is rejoined.
    if (collabRef.current) return;
    if (remote) { applyRemote(remote); return; } // fresh, editable mount
    const lexical = editorRef.current?.getLexicalEditor();
    editorRef.current?.setMarkdown(latestBody.current);
    settleMarkdown(lexical);
    // Each previewed version was an undo step; undoing into one afterwards would
    // put an old version back on screen and autosave it over the note.
    forgetHistory(lexical);
    lexical?.setEditable(true);
  }, [applyRemote]);

  // Close the editor modal: persist the draft first so closing never loses edits,
  // then return to the grid. Backdrop click and Escape both route here.
  const close = useCallback(async () => {
    // If history is open, the editor is showing a past version — put the live
    // draft back before flushing so closing never writes an old revision to disk.
    if (history) leaveHistory();
    // A still-locked note holds an empty body (withheld server-side) — flushing
    // would write that emptiness over the real content on disk.
    if (!isLocked) await flush();
    navigate(closeTo);
  }, [flush, navigate, history, isLocked, closeTo, leaveHistory]);

  // Escape closes the note (or leaves focus mode first). It stands down when
  // something on top owns the key — another modal (share, a confirm), history
  // (it leaves history first), the vault prompt — or when the editor already
  // used it (closing a slash menu or a typeahead marks the event handled).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // Tab indents inside the body, so without this a keyboard user could
      // never Tab out of it (WCAG 2.1.2). Escape leaves the body for the next
      // control after it — the note's actions — and a second Escape closes.
      const target = e.target as HTMLElement | null;
      if (target?.closest('.luthor-content-editable') && sheetRef.current) {
        const body = target.closest('.luthor-content-editable') as HTMLElement;
        const next = [...sheetRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        )].find((el) => !body.contains(el)
          && (body.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
        if (next) {
          e.preventDefault();
          next.focus();
          return;
        }
      }
      if (focus) { exitFocus(); return; }
      if (history || unlockToChangeLock) return;
      if (document.querySelectorAll('[aria-modal="true"]').length > 1) return;
      void close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, focus, exitFocus, history, unlockToChangeLock]);

  // React to a fresh server snapshot. SignalR's NoteUpdated invalidates the
  // notes query, so an external edit to the open note arrives here as a changed
  // `note` prop. Clean draft → apply instantly; dirty draft → hold + warn.
  useEffect(() => {
    const incoming = { title: note.title, body: note.body };
    if (note.id !== shown.current.id) { applyRemote(incoming); return; }
    if (incoming.title === shown.current.title && incoming.body === shown.current.body) return;
    if (collabLive) {
      // The room owns the body (peers' edits arrive through it, caret-safe);
      // only a title renamed elsewhere comes this way — taken unless ours is
      // mid-edit.
      if (incoming.title !== shown.current.title && titleRef.current === savedRef.current.title) {
        titleRef.current = incoming.title;
        setTitle(incoming.title);
        reset({ title: incoming.title, body: latestBody.current });
      }
      shown.current = { id: note.id, ...incoming };
      return;
    }
    if (history) {
      // Nothing unsaved can be lost: history is only entered after a flush, and
      // the canvas is read-only while it is open.
      deferredRemote.current = incoming;
      shown.current = { id: note.id, ...incoming };
      return;
    }
    // Our own save echoing back through the cache — adopt silently, no remount.
    if (incoming.title === savedRef.current.title && incoming.body === savedRef.current.body) {
      shown.current = { id: note.id, ...incoming };
      return;
    }
    // Ask the editor itself whether it is holding unsaved text, rather than
    // trusting the isDirty flag alone. The flag is React state set from an
    // event handler, so a remote revision that lands in the same tick as the
    // keystroke can be processed while it still reads false — and adopting then
    // wipes the user's unsaved words with no warning. The draft comparison is a
    // ref read, always current.
    const draft = getDraft();
    const holdingUnsaved = isDirty
      || draft.title !== savedRef.current.title
      || draft.body !== savedRef.current.body;
    if (!holdingUnsaved) { applyRemote(incoming); return; }
    // Dirty: protect the caret, surface the conflict for the user to resolve.
    shown.current = { id: note.id, ...incoming };
    setPending(incoming);
  }, [note, isDirty, applyRemote, savedRef, getDraft, history, collabLive, reset]);

  // Keep my local edits and let the next save overwrite the remote revision.
  const keepLocal = useCallback(() => { setPending(null); bump(); }, [bump]);

  // Edits arrive from the editor itself (luthor >=2.9.1 `onChange`). Before that
  // API existed Papyra had to sniff the DOM — Lexical stops propagation of the
  // contenteditable's `input` event, so a wrapper's onInput never fired and
  // typing was silently never saved. `source` distinguishes a real edit from our
  // own setMarkdown (remote adopt, time-machine preview), so a programmatic
  // mutation can no longer masquerade as one.
  const onEditorChange = useCallback(({ markdown, source }: { markdown: string; source: 'user' | 'programmatic' | 'remote' }) => {
    if (source !== 'user') return;
    // Live: every keystroke is already in the room, which saves it.
    if (collabRef.current && !suppressSave.current) return;
    if (awaitingBaseline.current) {
      awaitingBaseline.current = false;
      if (!hasBridgePlaceholder(markdown)) {
        latestBody.current = markdown;
        reset({ title: titleRef.current, body: markdown });
        return;
      }
    }
    // Belt and braces: while scrubbing history the canvas is showing a preview,
    // and nothing it emits may schedule a save over the live file.
    if (suppressSave.current) return;
    if (markdown === latestBody.current) return;
    latestBody.current = markdown;
    bump();
  }, [bump, reset]);

  // Toolbar frontmatter mutation: PUT the live draft plus the changed YAML field,
  // so a pin/color/archive flip never clobbers unsaved body/title. Re-baselines
  // the save state so the write doesn't immediately echo back as a dirty change.
  // Frontmatter writes (tags, colour, pin, archive) go out one at a time, in the
  // order they were made, each carrying every field's latest value. Fired
  // concurrently they raced: two quick tag adds each built on the note as it was
  // before either landed, a refetch in between put the older list back, and tags
  // went missing. `fm` is the latest intended frontmatter; it only re-reads the
  // note from the server once nothing is in flight.
  const fm = useRef({ tags: note.tags, color: note.color, pinned: note.pinned, archived: note.archived, kind: note.kind });
  const fmChain = useRef<Promise<void>>(Promise.resolve());
  const fmInFlight = useRef(0);
  useEffect(() => {
    if (fmInFlight.current === 0) {
      fm.current = { tags: note.tags, color: note.color, pinned: note.pinned, archived: note.archived, kind: note.kind };
    }
  }, [note]);

  const saveFrontmatter = useCallback((patch: Partial<Pick<Note, 'color' | 'pinned' | 'archived' | 'tags' | 'kind'>>): Promise<void> => {
    // While locked the draft body is the withheld (empty) one — writing it would
    // destroy the note's real content, so frontmatter edits wait for the unlock.
    if (isLocked) return Promise.resolve();
    fm.current = { ...fm.current, ...patch };
    const intended = fm.current;
    patchNoteInCache(queryClient, note.id, patch);
    if (isDraft) patchDraft(note.id, patch);
    fmInFlight.current++;
    const run = fmChain.current.then(async () => {
      const draft = getDraft();
      // Same offline-safe seam as the autosave path: parks in the outbox when the
      // API is unreachable instead of throwing away the toggle.
      await putNote(note.id, {
        title: draft.title,
        ...intended,
        body: draft.body,
        // `secure` is never sent from here (see toggleSecure); the API reads an
        // absent value as "leave the lock alone".
      }, note.updated, { collab: collabRef.current });
      reset(draft);
      // A color flip remounts the editor (theme swap, see key/style below); seed the
      // fresh mount with the live text so unsaved edits survive the remount.
      latestBody.current = draft.body;
      setBody(draft.body);
      shown.current = { id: note.id, title: draft.title, body: draft.body };
    }).catch(() => {
      toast('Couldn’t save that change.');
    }).finally(() => {
      fmInFlight.current--;
      // Refetch once the queue drains, so the cache settles on the final state
      // rather than flickering back through each intermediate one.
      if (fmInFlight.current === 0) void queryClient.invalidateQueries({ queryKey: ['notes'] });
    });
    fmChain.current = run;
    return run;
  }, [getDraft, note.id, note.updated, reset, queryClient, isLocked, toast, isDraft]);

  // Lock or unlock the note. Not through saveFrontmatter: that path parks a failed
  // write in the offline outbox, and the two refusals here are answers, not
  // outages — "set a PIN first" (409) and "open the vault first" (401) would sit
  // in the outbox retrying forever. Taking a lock off needs the vault open, so a
  // lapsed unlock asks for the PIN and then finishes the job.
  const toggleSecure = useCallback(async () => {
    if (isLocked) return;
    const next = !(note.secure ?? false);
    const draft = getDraft();
    let res: Response;
    try {
      res = await vaultFetch(`/api/notes/${encodeURIComponent(note.id)}`, {
        method: 'PUT',
        headers: collabRef.current
          ? { 'Content-Type': 'application/json', [COLLAB_HEADER]: 'frontmatter' }
          : { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: draft.title, tags: note.tags, color: note.color, pinned: note.pinned,
          archived: note.archived, kind: note.kind, body: draft.body, secure: next,
        }),
      });
    } catch {
      toast('Couldn’t change the lock — the server is unreachable.');
      return;
    }
    if (res.status === 409) {
      toast('Set a vault PIN before locking notes.', { label: 'Set PIN', onClick: () => navigate('/settings?tab=security&s=vault-pin') });
      return;
    }
    if (res.status === 401) { setUnlockToChangeLock(true); return; }
    if (!res.ok) { toast('Couldn’t change the lock.'); return; }

    setUnlockToChangeLock(false);
    patchNoteInCache(queryClient, note.id, { secure: next });
    reset(draft);
    latestBody.current = draft.body;
    setBody(draft.body);
    shown.current = { id: note.id, title: draft.title, body: draft.body };
    void queryClient.invalidateQueries({ queryKey: ['notes'] });
    toast(next ? 'Note locked and moved to the Vault.' : 'Note unlocked — it is back with your other notes.');
  }, [isLocked, note, getDraft, toast, navigate, queryClient, reset]);

  // Enter history. Flush any unsaved edits FIRST, so the live draft is on disk:
  // the server leaves out versions identical to the live file, and "Now" on the
  // timeline has to be what the person was just looking at. Then hard-disable
  // autosave and make the canvas read-only — a preview is not a draft.
  const openHistory = useCallback(async () => {
    if (history) return;
    await flush();
    // Live: "Now" is the room's text as on screen; the preview canvas starts there.
    if (collabRef.current) {
      let live: string | undefined;
      try { live = editorRef.current?.getMarkdown(); } catch { /* not synced yet */ }
      if (live !== undefined && !hasBridgePlaceholder(live)) latestBody.current = live;
      setBody(latestBody.current);
    }
    // Cancel any still-pending debounce from edits made just before opening —
    // otherwise it could fire mid-preview and flush the previewed (old) body.
    const draft = getDraft();
    reset(draft);
    suppressSave.current = true;
    editorRef.current?.getLexicalEditor()?.setEditable(false);
    setHistoryLive(draft);
    setHistoryView('preview');
    setHistory(true);
    // The timeline pins to the top of the sheet; start there, title in view.
    if (editorScrollRef.current) editorScrollRef.current.scrollTop = 0;
  }, [history, flush, reset, getDraft]);

  // Put one version (or the live note, for null) into the canvas.
  const previewVersion = useCallback((version: HistoryVersion | null) => {
    editorRef.current?.setMarkdown(version ? version.body : latestBody.current);
    settleMarkdown(editorRef.current?.getLexicalEditor());
    setPreviewTitle(version ? version.title : null);
  }, []);

  // Restore a version through the API, which archives the current version first,
  // so a restore is itself reversible: the response names the version holding
  // what was replaced, and the toast's Undo restores that. The restored note is
  // adopted straight from the response rather than waiting for the refetch, so
  // the editor never sits read-only on a stale preview if the refetch is slow.
  const postRestore = useCallback(async (snapshotId: string): Promise<string | null> => {
    // An Undo clicked from the toast can come after new typing: save it first, so
    // the server archives it before swapping the old version in.
    if (!suppressSave.current) await flush();
    const res = await vaultFetch(
      `/api/notes/${encodeURIComponent(note.id)}/restore/${encodeURIComponent(snapshotId)}`,
      { method: 'POST' },
    );
    if (!res.ok) throw new Error(`POST restore failed: ${res.status}`);
    const restored = (await res.json()) as Note;

    suppressSave.current = false;
    setPreviewTitle(null);
    setHistory(false);
    // The restore's own write may already have echoed back as a deferred remote
    // update; the response is newer than anything it could hold.
    deferredRemote.current = null;
    applyRemote({ title: restored.title, body: restored.body });
    void queryClient.invalidateQueries({ queryKey: ['notes'] });
    return res.headers.get('Papyra-Undo-Snapshot');
  }, [note.id, queryClient, applyRemote, flush]);

  const restoreVersion = useCallback(async (snapshotId: string, label: string) => {
    const undoId = await postRestore(snapshotId);
    toast(`Restored the version from ${label}.`, undoId ? {
      label: 'Undo',
      onClick: () => void postRestore(undoId).then(
        () => toast('Restore undone.'),
        () => toast('Couldn’t undo the restore.'),
      ),
    } : undefined);
  }, [postRestore, toast]);

  // Trash, through the shared rule: soft-delete with an Undo normally, and a
  // confirmed permanent delete when Trash is set to remove notes immediately.
  // Leave the editor only if the note actually went — backing out of the confirm
  // should leave the person where they were, still editing.
  //
  // Order matters. A pending autosave is flushed *first*, so a real last edit is
  // kept (in the trashed note). Then, once the note is gone, the save state is
  // re-baselined so the editor's unmount has nothing left to flush — a save that
  // lands after the trash would write the note back out of Trash.
  const trash = useCallback(async () => {
    // Never saved: there is nothing to put in Trash — just let it go.
    if (isDraft) {
      reset(getDraft());
      navigate(closeTo);
      return;
    }
    if (history) leaveHistory();
    if (!isLocked) await flush();
    if (await trashNote(note)) {
      reset(getDraft());
      navigate(closeTo);
    }
  }, [trashNote, note, navigate, closeTo, flush, reset, getDraft, isLocked, history, leaveHistory, isDraft]);

  // Sharing needs a note on the server to point at. Opening the share dialog
  // is a deliberate act, so it saves a draft first — empty or not.
  const openShare = useCallback(async () => {
    if (isDraft) {
      const draft = getDraft();
      await putNote(note.id, {
        title: draft.title, tags: note.tags, color: note.color, pinned: note.pinned,
        archived: note.archived, kind: note.kind, body: draft.body,
      });
      reset(draft);
      await queryClient.invalidateQueries({ queryKey: ['notes'] });
    }
    setShareOpen(true);
  }, [isDraft, getDraft, note, reset, queryClient]);

  // Archive: the frontmatter save carries the live draft, so nothing is left to
  // flush afterwards — cancel the debounce so a stale save (with archived: false
  // from the props it closed over) can't un-archive the note on unmount.
  const archive = useCallback(async () => {
    if (history) leaveHistory();
    const done = saveFrontmatter({ archived: true });
    reset(getDraft());
    navigate(closeTo);
    await done;
  }, [history, leaveHistory, saveFrontmatter, reset, getDraft, navigate, closeTo]);

  // YAML `color` tints the canvas; fonts come from the design tokens. The palette
  // tints are always light, so a coloured note forces a light editor (dark ink)
  // in both app themes — matching the card convention. Uncoloured notes follow
  // the live app theme. The luthor theme (and the `colored` light-lock) only
  // apply on mount, so those two go into the editor key. The tint itself does
  // not: it is the sheet's background, so picking another colour on an already
  // coloured note repaints without rebuilding the editor (and losing the caret).
  const colored = !!note.color;
  const editorTheme = colored ? 'light' : theme;
  // `--note-tint` paints the sheet (CSS mixes it by --tint-strength, exactly as
  // the card does) and lets chrome inside it (the floating toolbar) derive a
  // solid colour — the editor surface itself is transparent on a coloured note
  // so the paper shows through.
  const style = note.color
    ? ({ '--note-tint': note.color } as CSSProperties)
    : undefined;

  return (
    <div
      className={`note-modal${focus ? ' note-modal--focus' : ''}`}
      onMouseDown={(e) => { if (!focus && e.target === e.currentTarget) void close(); }}
    >
    <section
      ref={sheetRef}
      className={`note-editor${colored ? ` note-editor--colored${tintInkClass(note.color, theme)}` : ''}${focus ? ' note-editor--focus' : ''}${history ? ` note-editor--history note-editor--history-${historyView}` : ''}`}
      style={style}
      role="dialog"
      aria-modal="true"
      aria-label={`Note editor: ${title.trim() || 'Untitled'}`}
    >
      {history && (
        <NoteHistory
          noteId={note.id}
          live={historyLive}
          onPreview={previewVersion}
          onRestore={restoreVersion}
          onClose={leaveHistory}
          view={historyView}
          onViewChange={setHistoryView}
          diffSlot={diffSlot}
        />
      )}

      <div ref={editorScrollRef} className="note-editor__scroll">
      {focus && (
        <div className="note-editor__focusbar">
          {pendingUpdates > 0 && (
            <button type="button" className="note-editor__pending" onClick={() => flushUpdates()}>
              <RefreshCw size={14} /> {pendingUpdates} new update{pendingUpdates > 1 ? 's' : ''} pending
            </button>
          )}
          <button
            type="button"
            className="note-editor__focusbtn"
            aria-pressed={ambient.playing}
            aria-label={ambient.playing ? 'Mute ambient audio' : 'Play ambient audio'}
            onClick={ambient.toggle}
          >
            {ambient.playing ? <Volume2 size={16} /> : <VolumeX size={16} />}
          </button>
          <button type="button" className="note-editor__focusbtn" aria-label="Exit focus mode" onClick={exitFocus}>
            <Minimize2 size={16} />
          </button>
        </div>
      )}

      {history && <div ref={setDiffSlot} className="note-editor__diff-slot" />}

      {!focus && <NoteToc scrollRef={editorScrollRef} />}

      <header className="note-editor__bar">
        <input
          className="note-editor__title"
          value={previewTitle ?? title}
          placeholder="Untitled"
          aria-label="Note title"
          // Locked notes are read-only until unlocked: a title edit would schedule a
          // save whose (withheld) body is empty. History shows a past version.
          readOnly={isLocked || history}
          onChange={(e) => { titleRef.current = e.target.value; setTitle(e.target.value); bump(); }}
        />
        {collabLive && !history && !focus && (
          <CollabPresence
            provider={room.provider}
            status={room.status === 'offline' && !room.collaboration ? 'offline' : room.status}
            cursorsRef={cursorsRef}
            selfUid={room.self?.uid ?? null}
            viewOnly={!room.collaboration}
          />
        )}
      </header>

      {!focus && <TagEditor tags={note.tags} onChange={(tags) => saveFrontmatter({ tags })} />}

      {pending && (
        <div className="note-editor__conflict" role="alert">
          <span>This note was modified externally.</span>
          <div className="note-editor__conflict-actions">
            <button type="button" onClick={() => applyRemote(pending)}>Review</button>
            <button type="button" onClick={keepLocal}>Overwrite with Local</button>
          </div>
        </div>
      )}

      {isLocked && (
        <SecureNoteGate
          noteId={note.id}
          onUnlocked={(revealed) => {
            // Adopt the revealed body and re-baseline, so the unlock itself is never
            // mistaken for an edit.
            applyRemote({ title: note.title, body: revealed });
            setUnlocked(true);
          }}
        />
      )}

      {/* Edits are detected natively (see the observer effect) — Lexical swallows
          the bubbling `input` event, so a React onInput here would never fire. */}
      {!isLocked && (
      <div className="note-editor__canvas">
        {collabLive && !history && (room.status === 'gone' ? (
          <p className="note-editor__live-note" role="status">
            This note was moved to Trash, deleted or locked while it was open.
          </p>
        ) : room.collaboration ? (
          <>
            {/* Lexical ≥0.32 needs this provider above CollaborationPlugin;
                luthor's PapyraEditor doesn't add it. */}
            <LexicalCollaboration>
              <PapyraEditor
                // A new session (reconnect, access change) is a new Yjs doc: a
                // fresh editor. Theme/tint remounts rebind the same session.
                key={`${note.id}-live-${room.generation}-${editorTheme}-${colored ? 'tint' : 'plain'}`}
                initialTheme={theme}
                colored={colored}
                toolbar={toolbarShown && !focus}
                toolbarAlignment="center"
                toolbarLayout={PAPYRA_TOOLBAR_LAYOUT}
                toolbarItems={toolbarItems}
                imageUploadHandler={imageUploadHandler}
                defaultEditorView="visual"
                blockAnchors="off"
                placeholder="Start writing…"
                adapter={adapter}
                collaboration={room.collaboration}
                // No onChange: the room saves every keystroke, and luthor
                // baselines onChange with getMarkdown() at mount — which
                // throws on a collab doc the room hasn't filled yet.
                onDesync={(info) => console.warn('[papyra] editor DOM diverged from model', info)}
                onReady={(methods) => {
                  editorRef.current = methods;
                  const lexical = methods.getLexicalEditor();
                  setLexicalEditor(lexical ?? null);
                  lexical?.getRootElement()?.setAttribute('aria-label', 'Note body');
                  // Nothing to type into until the room has sent the note.
                  lexical?.setEditable(room.synced);
                }}
              />
            </LexicalCollaboration>
            {/* Peers' carets, labels and selection tints (Lexical paints them). */}
            <div ref={cursorsRef} className="collab-cursors" aria-hidden="true" />
          </>
        ) : room.status === 'offline' ? null : (
          <LoadingBar label="Joining the live note" />
        ))}
        {/* Classic editor: unshared notes, the engine being off, history
            previews of a live note, and a live note opened while offline
            (read-only: its edits belong to the room). */}
        {(!collabLive || history || (room.status === 'offline' && !room.collaboration)) && (
        <PapyraEditor
          key={`${note.id}-${editorKey}-${editorTheme}-${colored ? 'tint' : 'plain'}${collabLive ? '-ro' : ''}`}
          readOnly={collabLive}
          initialTheme={theme}
          colored={colored}
          // Not in focus mode (distraction-free) or while history previews an
          // old version (the canvas is read-only then).
          toolbar={toolbarShown && !focus && !history}
          toolbarAlignment="center"
          toolbarLayout={PAPYRA_TOOLBAR_LAYOUT}
          toolbarItems={toolbarItems}
          imageUploadHandler={imageUploadHandler}
          defaultEditorView="visual"
          // Existing anchors round-trip; none are created (see getSaveDraft).
          blockAnchors="off"
          defaultContent={body}
          placeholder="Start writing…"
          adapter={adapter}
          onChange={onEditorChange}
          // The editor reports divergence between its model and the DOM (text
          // written behind the reconciler's back by an extension or a password
          // manager renders but never reaches getMarkdown). Surface it instead of
          // letting the visible note and the saved note drift apart in silence.
          onDesync={(info) => console.warn('[papyra] editor DOM diverged from model', info)}
          onReady={(methods) => {
            editorRef.current = methods;
            const lexical = methods.getLexicalEditor();
            setLexicalEditor(lexical ?? null);
            // luthor's editable is a textbox with no accessible name; screen
            // readers announced a bare "edit text". Name it after its job.
            lexical?.getRootElement()?.setAttribute('aria-label', 'Note body');
            // defaultContent loads as plain text, so parse the markdown into the
            // visual surface explicitly — otherwise the body renders as raw source.
            methods.setMarkdown(body);
            // Both loads land on the undo stack, so the first Ctrl+Z after an edit
            // walked back past the note itself into that plain-text load — the
            // whole note flattened into one paragraph of raw `1. … ^id` source,
            // which autosave then wrote to disk. Opening a note is not an edit.
            forgetHistory(lexical);
            // Give focus back to whatever held it before the remount (the title,
            // a tag field…) — after Lexical has finished claiming the selection.
            const restore = focusToRestore.current;
            focusToRestore.current = null;
            if (restore) {
              requestAnimationFrame(() => requestAnimationFrame(() => {
                if (!restore.el.isConnected) return;
                restore.el.focus({ preventScroll: true });
                const field = restore.el as HTMLInputElement;
                if (restore.start !== null && typeof field.setSelectionRange === 'function') {
                  try { field.setSelectionRange(restore.start, restore.end ?? restore.start); } catch { /* not a text field */ }
                }
              }));
            }
            // A remount while history is open (a colour pick that tints the note,
            // an app theme switch) builds a fresh, editable canvas from the live
            // body — so history is over; leave it rather than leave its bar over
            // an editor that is no longer showing a preview.
            if (suppressSave.current && !collabRef.current) {
              suppressSave.current = false;
              setPreviewTitle(null);
              setHistory(false);
            }
            // onReady fires post-reconciliation as of luthor 2.9.1, so the editor's
            // own (normalised) serialization is a stable baseline right here — no
            // settle timer. Baselining against our input instead would make every
            // note look edited the moment it opened.
            // A placeholder serialization is not the note: baseline on the body
            // from disk and take luthor's first real serialization as the
            // baseline when it arrives (see onEditorChange).
            const read = methods.getMarkdown();
            awaitingBaseline.current = hasBridgePlaceholder(read);
            const normalised = awaitingBaseline.current ? body : read;
            latestBody.current = normalised;
            // Re-baseline the *save* baseline too, not just the mirror. It starts
            // life as the raw bytes from disk, and markdown that Papyra didn't
            // author round-trips through Lexical with cosmetic differences (a
            // blank line after `## Heading`, list bullet style). Every note that
            // arrived from Obsidian, an import, git-sync or the API therefore read
            // as dirty before a single keystroke — which the caret guard then
            // honoured by refusing remote updates and showing "This note was
            // modified externally / Overwrite with Local" on a note the user had
            // never touched. The draft is clean by definition here: the editor was
            // just built from this body and nothing has been typed.
            reset({ title: titleRef.current, body: normalised });
          }}
        />
        )}
      </div>
      )}

      {unlockToChangeLock && (
        <div className="note-editor__vault-prompt" role="dialog" aria-label="Unlock the vault">
          <p>Unlock your vault to take the lock off this note.</p>
          <VaultUnlock autoBiometric onUnlocked={() => void toggleSecure()} />
          <button type="button" className="note-editor__vault-cancel" onClick={() => setUnlockToChangeLock(false)}>
            Cancel
          </button>
        </div>
      )}

      {!isLocked && !history && (
        <div className="note-editor__links"><LinkCards body={note.body} /></div>
      )}
      {!isLocked && <LinkHoverCard within={editorScrollRef} />}

      {!focus && !isLocked && !history && <GhostCards noteId={note.id} />}
      </div>

      {/* Outside the scroll area, so "Drop to attach" covers the whole sheet. */}
      {!isLocked && !history && (
        <MediaTools editor={lexicalEditor} sheetRef={sheetRef} upload={adapter.uploadMedia} onError={(m) => toast(m)} />
      )}

      {/* Actions and save state sit under the note body, outside the scroll
          area, so a long note keeps them in reach at the bottom of the sheet. */}
      {!focus && (
        <footer className="note-editor__footer">
          <NoteToolbar
            formattingOpen={toolbarShown}
            onFormatting={() => setToolbarOverride({ scope: toolbarScope, shown: !toolbarShown })}
            pinned={note.pinned}
            color={note.color}
            onTogglePin={() => void saveFrontmatter({ pinned: !note.pinned })}
            onPickColor={(c) => void saveFrontmatter({ color: c })}
            historyOpen={history}
            onHistory={() => (history ? leaveHistory() : void openHistory())}
            onFocus={enterFocus}
            secure={note.secure ?? false}
            canToggleSecure={!isLocked}
            onToggleSecure={() => void toggleSecure()}
            onArchive={() => void archive()}
            onShare={() => void openShare()}
            onTrash={() => {
              void trash();
            }}
          />
          <span className="note-editor__status" role="status">
            {STATUS_LABEL[status]}
          </span>
          {!isDraft && !history && <EditedStamp updated={note.updated} />}
        </footer>
      )}

      {shareOpen && <ShareDialog note={note} onClose={() => setShareOpen(false)} />}
    </section>
    </div>
  );
}
