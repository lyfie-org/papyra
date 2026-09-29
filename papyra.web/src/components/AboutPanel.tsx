import { FileText, ShieldCheck, Search, History, Lock, Users, Star, ExternalLink, Bug, BookOpen, Heart } from 'lucide-react';
import logo from '../assets/papyra_logo.png';
import { APP_VERSION_LABEL, GITHUB_URL, LICENSE, SITE_URL } from '../lib/appInfo';
import { useServerVersion, versionLabel } from '../lib/serverVersion';
import './AboutPanel.css';

/** GitHub's mark. lucide dropped brand icons, and this link is to GitHub. */
function GitHubMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

const FEATURES = [
  { icon: FileText, title: 'Plain files, forever', text: 'Every note is a Markdown file on a disk you own. Open it in any editor, grep it, back it up, walk away with it.' },
  { icon: ShieldCheck, title: 'Private by design', text: 'Runs on your server. No cloud account, no tracking, no one reading over your shoulder.' },
  { icon: Search, title: 'Instant search', text: 'Full-text search that finds what you wrote a second ago, across every note you have ever kept.' },
  { icon: History, title: 'A time machine', text: 'Every version of every note is kept. Scrub back through its history and restore any moment.' },
  { icon: Lock, title: 'A vault with a lock', text: 'Secure notes stay sealed behind your PIN or your fingerprint, even from a signed-in session.' },
  { icon: Users, title: 'Share on your terms', text: 'Invite people on your server, or hand out a link that expires when you say it does.' },
];

export default function AboutPanel() {
  const server = useServerVersion();
  const version = server.version ? versionLabel(server.version) : APP_VERSION_LABEL;
  return (
    <div className="settings__panel about">
      <header className="about__hero">
        <img className="about__logo" src={logo} alt="" aria-hidden="true" />
        <div className="about__title">
          <h2 id="about-papyra" className="about__name">
            Papyra <span className="about__version">{version}</span>
          </h2>
          <p className="about__tagline">A calm, self-hosted home for your notes.</p>
        </div>
      </header>

      <p className="about__lede">
        Papyra is a notebook you actually own. Your writing lives as plain text on your own
        machine — readable by anything, locked into nothing — and Papyra is the quiet, fast desk
        on top of it: a live editor, instant search, sharing, a locked vault and a full history
        of every change.
      </p>

      <ul className="about__features">
        {FEATURES.map(({ icon: Icon, title, text }) => (
          <li key={title} className="about__feature">
            <span className="about__feature-icon" aria-hidden="true"><Icon size={18} /></span>
            <span>
              <span className="about__feature-title">{title}</span>
              <span className="about__feature-text">{text}</span>
            </span>
          </li>
        ))}
      </ul>

      <section className="about__star" aria-labelledby="about-star">
        <div>
          <h3 id="about-star" className="about__star-title">
            <Heart size={16} aria-hidden="true" /> Enjoying Papyra?
          </h3>
          <p className="about__star-text">
            It’s free and open source, built in the open. A star on GitHub is the simplest way to
            say thanks — and it helps other people find it.
          </p>
        </div>
        <a className="about__star-btn" href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
          <GitHubMark /> <Star size={15} aria-hidden="true" /> Star on GitHub
        </a>
      </section>

      <nav className="about__links" aria-label="Papyra links">
        <a href={SITE_URL} target="_blank" rel="noopener noreferrer"><BookOpen size={15} aria-hidden="true" /> Docs &amp; guides</a>
        <a href={`${GITHUB_URL}/releases`} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} aria-hidden="true" /> What’s new</a>
        <a href={`${GITHUB_URL}/issues`} target="_blank" rel="noopener noreferrer"><Bug size={15} aria-hidden="true" /> Report a bug</a>
        <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer"><GitHubMark size={15} /> Source code</a>
      </nav>

      <dl className="settings__details about__details">
        <div><dt>Version</dt><dd>{version}{server.stale && <> · <button type="button" className="about__reload" onClick={() => window.location.reload()}>reload to update this tab</button></>}</dd></div>
        <div><dt>Notes stored as</dt><dd>Markdown files with YAML front matter</dd></div>
        <div><dt>Built with</dt><dd>.NET · React · SQLite · Lucene</dd></div>
        <div>
          <dt>License</dt>
          <dd><a href={`${GITHUB_URL}/blob/main/LICENSE`} target="_blank" rel="noopener noreferrer">{LICENSE}</a></dd>
        </div>
      </dl>
    </div>
  );
}
