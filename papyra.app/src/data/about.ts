// What Papyra is, said once — for the page's FAQ, its structured data and the
// plain-text summaries for search engines and AI assistants (/llms.txt).
//
// Every line here must be true of the shipped product. If a feature changes,
// change it here and every surface follows.

import {
  CREATOR_NAME,
  CREATOR_URL,
  DESCRIPTION,
  DOCKER_HUB_URL,
  GITHUB_URL,
  LICENSE,
  LYFIE_PROJECT_URL,
  LYFIE_URL,
  SITE_URL,
} from './site';

export const KEYWORDS = [
  'self-hosted notes app',
  'private note-taking app',
  'open-source Google Keep alternative',
  'Markdown notes',
  'self-hosted Markdown editor',
  'notes app with no tracking',
  'Docker notes app',
  'home lab',
];

export const FEATURES = [
  'Every note is a plain Markdown (.md) file with YAML frontmatter, on your own server',
  'No tracking, analytics or crash reports; the only call home is an optional daily update check (one environment variable turns it off), which the maker also uses as a count of installs',
  'Autosave with full version history; scrub back to any earlier version',
  'Full-text search across notes, to-dos and collections, with highlighted matches',
  'Wiki links ([[note]]) and backlinks',
  'Live collaboration on shared notes, with cursors and presence',
  'Sharing, @mentions, comments and notifications',
  'Locked notes, encrypted at rest, opened with a vault PIN or biometrics',
  'Passkey sign-in, authenticator-app two-factor, and single sign-on (OIDC)',
  'Email alerts through your own SMTP server',
  'Works offline as an installable web app; edits sync when you reconnect',
  'Pictures, PDFs and video in notes, previewed inline',
  'A journal: one page a day with moods, a streak, a calendar, voice notes and lockable days, stored as plain files like everything else',
  'Import from Google Keep (Takeout), Obsidian and Day One; drag in any .md file',
  'Backups: Git sync (optionally encrypted), zip export, encrypted archives',
  'Smart collections, tags, to-do lists, focus mode, light and dark themes',
  'Multiple private accounts on one server',
  'REST API with API keys, and signed webhooks',
  'One Docker container, one volume; amd64 and arm64',
];

export const FAQ: { q: string; a: string }[] = [
  {
    q: 'What is Papyra?',
    a: 'A free, open-source, self-hosted note-taking app. It is as simple as Google Keep, links notes like a wiki, and keeps every note as a plain Markdown file on your own server.',
  },
  {
    q: 'Is Papyra really private?',
    a: 'Yes. Papyra has no tracking, analytics or crash reports, and its interface makes no third-party requests, and even its fonts come from your server. The server makes one request of its own: a daily check for a newer version, which I also use as a count of installs to stay motivated. It is optional. Set PAPYRA_UPDATE_CHECK_ENABLED=false and it never calls out (details at papyra.app/docs/update-check). Your notes only leave your server if you share one, set up a Git backup, or configure email alerts. Locked notes are encrypted on disk.',
  },
  {
    q: 'Is Papyra free?',
    a: `Yes. It is open source under the ${LICENSE}, with no paid tier, no licence key and no account with us.`,
  },
  {
    q: 'Can I move my notes from Google Keep or Obsidian?',
    a: 'Yes. Import a Google Keep Takeout archive (checklists, labels, colours and pins come with it) or upload an Obsidian vault with its links and attachments. A Day One journal comes in as days of the journal. You can also drag any Markdown file into the app.',
  },
  {
    q: 'What do I need to run it?',
    a: 'Docker. Papyra is one container with one volume, and runs on amd64 and arm64, so a NAS, a Raspberry Pi or a small VPS all work. Installing takes one command.',
  },
  {
    q: 'Does it work offline and on my phone?',
    a: 'Yes. Papyra installs as an app on phones, tablets and computers, opens without a connection, and syncs offline edits when you are back. Native desktop and mobile apps are planned.',
  },
  {
    q: 'What happens to my notes if I stop using Papyra?',
    a: 'Nothing happens to them. They are ordinary Markdown files in a folder you own, and any text editor can open them.',
  },
  {
    q: 'Who makes Papyra?',
    a: 'Papyra is a Lyfie project, built in the open on GitHub. Its editor is luthor, also from Lyfie.',
  },
];

/** The schema.org graph for the home page: who publishes Papyra, and what it is. */
export function homeGraph({
  version,
  pulls,
  screenshot,
}: {
  version: string | null;
  pulls: number | null;
  screenshot: string;
}) {
  const org = { '@id': `${LYFIE_URL}/#organization` };
  const person = { '@id': `${CREATOR_URL}/#person` };
  const app = { '@id': `${SITE_URL}/#software` };

  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        ...org,
        name: 'Lyfie',
        url: LYFIE_URL,
        logo: `${LYFIE_URL}/android-chrome-512x512.png`,
        sameAs: ['https://github.com/lyfie-org'],
        founder: person,
      },
      {
        '@type': 'Person',
        ...person,
        name: CREATOR_NAME,
        url: CREATOR_URL,
        affiliation: org,
      },
      {
        '@type': 'WebSite',
        '@id': `${SITE_URL}/#website`,
        url: SITE_URL,
        name: 'Papyra',
        description: DESCRIPTION,
        inLanguage: 'en',
        publisher: org,
        about: app,
      },
      {
        '@type': 'SoftwareApplication',
        ...app,
        name: 'Papyra',
        alternateName: 'Papyra notes',
        description: DESCRIPTION,
        url: SITE_URL,
        image: `${SITE_URL}/og.png`,
        screenshot,
        applicationCategory: 'ProductivityApplication',
        applicationSubCategory: 'Note-taking',
        operatingSystem: 'Linux, macOS, Windows (Docker); any modern browser',
        downloadUrl: DOCKER_HUB_URL,
        installUrl: `${SITE_URL}/docs/install/`,
        codeRepository: GITHUB_URL,
        license: 'https://www.gnu.org/licenses/gpl-3.0.html',
        isAccessibleForFree: true,
        keywords: KEYWORDS.join(', '),
        featureList: FEATURES,
        author: org,
        publisher: org,
        creator: person,
        sameAs: [GITHUB_URL, DOCKER_HUB_URL, LYFIE_PROJECT_URL],
        ...(version ? { softwareVersion: version } : {}),
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        ...(pulls !== null
          ? {
              interactionStatistic: {
                '@type': 'InteractionCounter',
                interactionType: { '@type': 'DownloadAction' },
                userInteractionCount: pulls,
              },
            }
          : {}),
      },
      {
        '@type': 'FAQPage',
        '@id': `${SITE_URL}/#faq`,
        mainEntity: FAQ.map(({ q, a }) => ({
          '@type': 'Question',
          name: q,
          acceptedAnswer: { '@type': 'Answer', text: a },
        })),
      },
    ],
  };
}
