import { useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import { Check, Copy, ExternalLink } from 'lucide-react';
import './TotpQr.css';

/**
 * The authenticator-app enrolment card: a QR code to scan, the same link as a
 * tap target (on a phone the QR is on the screen you'd scan it with), and the
 * secret spelled out for apps that want it typed.
 */
export default function TotpQr({ secret, uri }: { secret: string; uri: string }) {
  const [copied, setCopied] = useState(false);

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

  return (
    <div className="totp-qr">
      <svg className="totp-qr__code" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="QR code for your authenticator app" shapeRendering="crispEdges">
        <rect width={size} height={size} className="totp-qr__paper" />
        <path d={d} className="totp-qr__ink" />
      </svg>
      <div className="totp-qr__side">
        <a className="totp-qr__open" href={uri}>
          Open in authenticator app <ExternalLink size={13} aria-hidden="true" />
        </a>
        <span className="totp-qr__label">Or enter this key</span>
        <span className="totp-qr__secret">
          <code>{spaced}</code>
          <button type="button" className="totp-qr__copy" onClick={() => void copy()} aria-label="Copy key">
            {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          </button>
        </span>
      </div>
    </div>
  );
}
