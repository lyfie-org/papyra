import { useMemo, useState, useSyncExternalStore } from 'react';
import qrcode from 'qrcode-generator';
import { Check, Copy, ExternalLink } from 'lucide-react';
import './TotpQr.css';

// A touch device is almost always the phone the authenticator lives on: its own
// screen can't be scanned, so there the tap target leads and the QR is tucked away.
const COARSE = '(pointer: coarse)';
function useTouchDevice(): boolean {
  return useSyncExternalStore(
    notify => {
      const mq = window.matchMedia(COARSE);
      mq.addEventListener('change', notify);
      return () => mq.removeEventListener('change', notify);
    },
    () => window.matchMedia(COARSE).matches,
    () => false,
  );
}

/**
 * The authenticator-app enrolment card: a QR code to scan, the same link as a
 * tap target, and the secret spelled out for apps that want it typed. On a
 * phone the tap target comes first and the QR sits behind a disclosure.
 */
export default function TotpQr({ secret, uri }: { secret: string; uri: string }) {
  const [copied, setCopied] = useState(false);
  const touch = useTouchDevice();

  // One path of dark modules: crisp at any size, inked by tokens.
  const { size, d } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(uri);
    qr.make();
    const n = qr.getModuleCount();
    let path = '';
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++)
        if (qr.isDark(r, c)) path += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { size: n + 8, d: path };
  }, [uri]);

  // Groups of four, as authenticator apps print it.
  const spaced = secret.replace(/(.{4})/g, '$1 ').trim();

  async function copy() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked: the key is on screen to select */ }
  }

  const qr = (
    <svg className="totp-qr__code" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="QR code for your authenticator app" shapeRendering="crispEdges">
      <rect width={size} height={size} className="totp-qr__paper" />
      <path d={d} className="totp-qr__ink" />
    </svg>
  );
  const key = (
    <>
      <span className="totp-qr__label">Or enter this key</span>
      <span className="totp-qr__secret">
        <code>{spaced}</code>
        <button type="button" className="totp-qr__copy" onClick={() => void copy()} aria-label="Copy key">
          {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
        </button>
      </span>
    </>
  );

  if (touch) {
    return (
      <div className="totp-qr totp-qr--touch">
        <a className="totp-qr__open totp-qr__open--primary" href={uri}>
          Open authenticator app <ExternalLink size={14} aria-hidden="true" />
        </a>
        <div className="totp-qr__side">{key}</div>
        <details className="totp-qr__more">
          <summary>Scan a QR code instead</summary>
          {qr}
        </details>
      </div>
    );
  }

  return (
    <div className="totp-qr">
      {qr}
      <div className="totp-qr__side">
        <a className="totp-qr__open" href={uri}>
          Open in authenticator app <ExternalLink size={13} aria-hidden="true" />
        </a>
        {key}
      </div>
    </div>
  );
}
