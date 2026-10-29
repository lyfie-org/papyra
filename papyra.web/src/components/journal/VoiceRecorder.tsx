import { useEffect, useRef, useState } from 'react';
import { Mic, Square, X } from 'lucide-react';
import BusyButton from '../BusyButton';
import { clock, MAX_VOICE_SECONDS, pickVoiceFormat, toWav, voiceFileName, type VoiceFormat } from '../../lib/journalVoice';
import './VoiceRecorder.css';

interface Props {
  /** The day the recording belongs to (`yyyy-MM-dd`), for its file name. */
  day: string;
  /** Hand over a WAV the server can transcribe, rather than the compact original. */
  transcribe: boolean;
  /** Upload the finished file and put it in the page. */
  onFile: (file: File) => Promise<void>;
  onClose: () => void;
}

type Phase = 'asking' | 'recording' | 'finishing' | 'error';

function whyNot(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Papyra can’t use the microphone. Allow it in the browser’s site settings and try again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found.';
  if (name === 'NotReadableError') return 'The microphone is busy in another app.';
  return 'Couldn’t start recording.';
}

/**
 * A voice note, made in the page: the microphone asks once, the clock runs, Stop puts
 * the recording in the day like any attached file. Nothing leaves the device until Stop;
 * Cancel (or Esc) throws the take away.
 */
export default function VoiceRecorder({ day, transcribe, onFile, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>('asking');
  const [seconds, setSeconds] = useState(0);
  const [message, setMessage] = useState('');
  const [canRetry, setCanRetry] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const format = useRef<VoiceFormat | null>(null);
  const chunks = useRef<Blob[]>([]);
  const pending = useRef<File | null>(null);
  const startedAt = useRef(0);
  const stopRef = useRef<HTMLButtonElement>(null);
  const keep = useRef(true);
  const onCloseRef = useRef(onClose);
  const finishRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => { onCloseRef.current = onClose; });

  const release = () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };

  useEffect(() => {
    let alive = true;
    keep.current = true; // a remount (StrictMode) starts a take afresh
    void (async () => {
      const picked = pickVoiceFormat((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m));
      if (!picked) { setMessage('This browser can’t record audio.'); setPhase('error'); return; }
      format.current = picked;
      let media: MediaStream;
      try {
        media = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (error) {
        if (alive) { setMessage(whyNot(error)); setPhase('error'); }
        return;
      }
      if (!alive) { media.getTracks().forEach((t) => t.stop()); return; }
      stream.current = media;
      const rec = new MediaRecorder(media, { mimeType: picked.mime });
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.current.push(e.data); };
      recorder.current = rec;
      rec.start(1000); // in slices, so a crash mid-take keeps most of it
      startedAt.current = Date.now();
      setPhase('recording');
    })();
    return () => {
      alive = false;
      keep.current = false;
      if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop();
      release();
    };
  }, []);

  useEffect(() => {
    if (phase !== 'recording') return;
    stopRef.current?.focus();
    const id = setInterval(() => {
      const elapsed = (Date.now() - startedAt.current) / 1000;
      setSeconds(elapsed);
      if (elapsed >= MAX_VOICE_SECONDS) { clearInterval(id); void finishRef.current(); }
    }, 250);
    return () => clearInterval(id);
  }, [phase]);

  const finish = async () => {
    const rec = recorder.current;
    const picked = format.current;
    if (!rec || !picked || phase !== 'recording') return;
    setPhase('finishing');
    const stopped = new Promise<void>((resolve) => { rec.onstop = () => resolve(); });
    rec.stop();
    await stopped;
    release();
    if (!keep.current) return;
    try {
      let blob = new Blob(chunks.current, { type: rec.mimeType || picked.mime });
      let ext: string = picked.ext;
      if (transcribe) {
        // The server reads only WAV; if converting fails, the recording itself still goes in.
        try { blob = await toWav(blob); ext = '.wav'; } catch { /* keep the original */ }
      }
      pending.current = new File([blob], voiceFileName(day, new Date(), ext), { type: blob.type });
    } catch {
      setMessage('Couldn’t save the recording.');
      setPhase('error');
      return;
    }
    await send();
  };

  /** Upload what was recorded; a failure keeps the take so it can be sent again. */
  const send = async () => {
    const file = pending.current;
    if (!file) return;
    setPhase('finishing');
    try {
      await onFile(file);
      pending.current = null;
      onCloseRef.current();
    } catch {
      setMessage('Couldn’t add the recording.');
      setCanRetry(true);
      setPhase('error');
    }
  };

  const cancel = () => { keep.current = false; onCloseRef.current(); };

  useEffect(() => { finishRef.current = finish; });

  return (
    <div
      className={`voice-recorder${phase === 'recording' ? ' is-recording' : ''}`}
      role="group"
      aria-label="Voice note"
      onKeyDown={(e) => { if (e.key === 'Escape' && phase !== 'finishing') { e.stopPropagation(); cancel(); } }}
    >
      <Mic size={16} aria-hidden="true" className="voice-recorder__icon" />
      <p className="voice-recorder__state" role="status">
        {phase === 'asking' && 'Waiting for the microphone…'}
        {phase === 'recording' && 'Recording'}
        {phase === 'finishing' && 'Adding it to the page…'}
        {phase === 'error' && message}
      </p>
      {phase === 'recording' && (
        <span className="voice-recorder__clock" aria-hidden="true">{clock(seconds)} / {clock(MAX_VOICE_SECONDS)}</span>
      )}
      <span className="voice-recorder__actions">
        {phase === 'recording' && (
          <BusyButton ref={stopRef} type="button" className="voice-recorder__stop" busyLabel="Adding…" onClick={finish}>
            <Square size={13} aria-hidden="true" /> Stop
          </BusyButton>
        )}
        {phase === 'error' && canRetry && (
          <BusyButton type="button" className="voice-recorder__stop" busyLabel="Adding…" onClick={send}>Try again</BusyButton>
        )}
        {phase !== 'finishing' && (
          <button type="button" className="voice-recorder__cancel" onClick={cancel}>
            <X size={14} aria-hidden="true" /> {phase === 'error' ? 'Close' : 'Cancel'}
          </button>
        )}
      </span>
    </div>
  );
}
