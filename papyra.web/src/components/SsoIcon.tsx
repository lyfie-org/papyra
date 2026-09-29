import { KeyRound } from 'lucide-react';
import { KIND_ICON, SSO_ICONS } from '../lib/ssoIcons';

/** A provider's mark: its uploaded image, else its chosen or default glyph. */
export function SsoIcon({ kind, icon, iconData, size = 18 }: {
  kind: string; icon?: string | null; iconData?: string | null; size?: number;
}) {
  if (iconData) return <img src={iconData} alt="" width={size} height={size} className="sso-icon sso-icon--img" />;
  const key = icon || KIND_ICON[kind] || 'key';
  const glyph = SSO_ICONS[key];
  if (!glyph) return <KeyRound size={size} aria-hidden="true" className="sso-icon" />;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true" className="sso-icon">
      <path d={glyph.path} />
    </svg>
  );
}
