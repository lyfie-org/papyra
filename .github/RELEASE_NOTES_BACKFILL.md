# Release notes backfill

Paste each block into its GitHub release (Releases → ✏️ Edit). Newest first.
Template for future releases: [RELEASE_TEMPLATE.md](RELEASE_TEMPLATE.md).

---

## v0.3.1

````markdown
Small polish release on top of 0.3.0.

## 🚀 New features
- **Rename and pin shared notes for yourself.** A note someone shared with you can now be renamed and pinned on your desk without changing it for anyone else.
- **Mobile drawer.** The side menu works properly on phones now.

## ✨ Improvements
- Tidier media bar when you select a picture, video or file in a note.

## 🐛 Bug fixes
- Long notes with a stray, unclosed `[[` no longer slow the editor down.

## 🧰 For self-hosters
- CI only runs the parts a change touches, so releases ship faster. Nothing to do on your side.

## 📦 Upgrade
```bash
docker compose pull && docker compose up -d
```

**Full changelog:** https://github.com/lyfie-org/papyra/compare/v0.3.0...v0.3.1
````

---

## v0.3.0

````markdown
This one is all about attachments: they're now searchable, safer to import, and come with you when you export.

## 🌟 Highlights

### Search inside your attachments
Text read out of scanned images (OCR) and audio recordings (transcripts) is now part of search. It runs in the background and picks up where it left off after a restart. Locked notes are never indexed.

### Export includes attachments
Your export zip now has every picture, video and file your notes use, so `![[links]]` still work wherever you open it. The download starts right away, even for big libraries, and locked notes go in their own folder.

## ✨ Improvements
- iPhone photos (HEIC) get proper thumbnails.
- Imports never overwrite an existing attachment — a clashing name gets a fresh one and the note is pointed at it.
- When someone you shared a note with edits it, your previous version is saved to History first.

## 🐛 Bug fixes
- A locked note can no longer be wiped by an edit coming from outside your unlocked vault.

## 📦 Upgrade
```bash
docker compose pull && docker compose up -d
```
Existing attachments get scanned once after the upgrade; this may keep the CPU busy for a bit on a large vault.

**Full changelog:** https://github.com/lyfie-org/papyra/compare/v0.2.6...v0.3.0
````

---

## v0.2.6

````markdown
Better uploads and media across the board.

## 🌟 Highlights

### PDF previews
PDFs now show a preview right on the file card — no download needed to see what it is.

### Smoother uploads
- Papyra checks size limits *before* uploading, so you find out right away instead of after waiting.
- Big uploads stream to the server and drop a whole camera roll without failing.
- Videos get a poster frame, and pause themselves when you scroll past.
- iPhone photos (HEIC) are supported.

## ✨ Improvements
- Thumbnails load faster and switching themes no longer reloads the editor.
- Backup restores and imports with lots of pictures are no longer rejected for being too big (up to 4 GB by default).

## 🔒 Security
- A file's real content decides its type, not its name — a renamed page can't sneak in as an image.
- Pictures in locked notes only load while the vault is unlocked.
- Used-up view-once links no longer serve the note's pictures.

## 📦 Upgrade
```bash
docker compose pull && docker compose up -d
```

**Full changelog:** https://github.com/lyfie-org/papyra/compare/v0.2.5...v0.2.6
````

---

## v0.2.5

````markdown
## 🌟 Highlights

### Comments on notes
Select some text and leave a comment. Threads stick to the text they're about, and people get notified when you reply.

### Friendly error pages
When something goes wrong you now get a clear page with what happened and what to try, instead of a blank screen.

## ✨ Improvements
- Opening a live shared note shows a preview while it connects.

## 🐛 Bug fixes
- Fixed an error page some people hit when signing in with SSO.
- View-once links now behave correctly.

## 🧰 For self-hosters
- New `PAPYRA_ERROR_DETAILS` — show technical details on error pages. Leave off in production.

## 📦 Upgrade
```bash
docker compose pull && docker compose up -d
```

**Full changelog:** https://github.com/lyfie-org/papyra/compare/v0.2.4...v0.2.5
````

---

## v0.2.4

````markdown
## ⚠️ Breaking changes
- **SSO no longer creates accounts.** Signing in with SSO now only works for people who already have a Papyra account. The first SSO sign-in links to the account with the same email. Create accounts for new people first.

## 🚀 New features
- **More than one SSO provider.** Add several (e.g. Google and Authentik) and pick on the sign-in page.
- **Rename things.** Give your devices, authenticators and passkeys names you'll recognise.

## ✨ Improvements
- Big libraries scroll much faster — the notes grid only draws what's on screen.
- The app notices when the server was updated and refreshes its version.
- SSO failures now explain what went wrong.

## 🧰 For self-hosters
- Behind a reverse proxy on a private network (Docker, LAN), Papyra now sees real visitor IPs by default. Use `PAPYRA_TRUSTED_PROXIES` to narrow it, or set it to `none` if Papyra is exposed directly.

## 📦 Upgrade
```bash
docker compose pull && docker compose up -d
```

**Full changelog:** https://github.com/lyfie-org/papyra/compare/v0.2.3...v0.2.4
````

---

## v0.2.3

````markdown
Quick fix for SSO.

## 🐛 Bug fixes
- SSO now tells your identity provider the correct return address when Papyra runs behind a public URL. If SSO sign-in was bouncing back with a redirect error, this fixes it.

## 📦 Upgrade
```bash
docker compose pull && docker compose up -d
```

**Full changelog:** https://github.com/lyfie-org/papyra/compare/v0.2.2...v0.2.3
````

---

## v0.2.2

````markdown
## ⚠️ Breaking changes
- You may be signed out once after upgrading. Just sign in again.

## 🚀 New features
- **Multiple authenticator apps.** Add your phone *and* your password manager — either one works. You always keep at least one.
- **One session per browser.** Signing in again on the same browser replaces the old session, so your device list stays clean.

## ✨ Improvements
- Settings are calmer: you see your current values first and hit **Edit** to change them, instead of a wall of open fields.

## 📦 Upgrade
```bash
docker compose pull && docker compose up -d
```

**Full changelog:** https://github.com/lyfie-org/papyra/compare/v0.2.1...v0.2.2
````

---

## v0.2.1

````markdown
## ⚠️ Breaking changes
- **Every account now needs an authenticator app.** If you don't have one yet, Papyra asks you to set it up on your next sign-in.
- **Two-step sign-in** is always on for admins and on by default for everyone else. SSO and passkey sign-ins skip it (they already count as two factors).

## 🚀 New features
- **Two-step sign-in.** Password, then a code from your authenticator. Tick "remember this browser" to skip the code for a while. No phone handy? Get the code by email instead (if email is set up).
- **Signed-in devices.** See every browser signed in to your account and sign any of them out.
- **SSO setup guide.** A step-by-step guide in Settings with a **Test** button that checks your provider before anyone tries to sign in.

## ✨ Improvements
- Emails now carry the Papyra logo.

## 📦 Upgrade
```bash
docker compose pull && docker compose up -d
```

**Full changelog:** https://github.com/lyfie-org/papyra/compare/v0.2.0...v0.2.1
````

---

## v0.2.0

````markdown
The big one: **live collaboration**.

## 🌟 Highlights

### Edit shared notes together, live
Open a shared note at the same time as someone else and you'll see each other's cursors and edits as they happen. Everyone gets their own undo, and History shows who changed what.

It all runs inside the same Papyra container — no extra service to set up. Your notes are still plain `.md` files on disk.

### Works offline too
Lost your connection? A live note still opens from the copy on your device.

## ✨ Improvements
- Restoring an old version while others are editing just works.

## 🧰 For self-hosters
- Live editing is on by default. To turn it off: `PAPYRA_COLLAB_ENABLED=false`.
- `/health` now also reports the live-editing engine.

## 📦 Upgrade
```bash
docker compose pull && docker compose up -d
```

**Full changelog:** https://github.com/lyfie-org/papyra/compare/v0.1.24...v0.2.0
````

---

## v0.1.24

````markdown
## ⚠️ Breaking changes
- On a **new** install, the first admin must set up an authenticator app during setup. Existing installs aren't affected.

## 🚀 New features
- **Authenticator app codes.** Add Google Authenticator, Bitwarden, 1Password etc. in Settings → Security. Sensitive actions ask for a code.

## ✨ Improvements
- `[[links]]` between notes now open in place instead of a new tab.
- Settings got a calmer, less cluttered look.

## 📦 Upgrade
```bash
docker compose pull && docker compose up -d
```

**Full changelog:** https://github.com/lyfie-org/papyra/compare/v0.1.23...v0.1.24
````

---

## v0.1.23

````markdown
## 🌟 Highlights

### Guided first-run setup
A fresh Papyra now walks you through setup step by step: your account, time zone, email and backups.

### Encrypted GitHub backup
Back up your notes to a private GitHub repo, encrypted so only you can read them. Restoring is built in.

## ✨ Improvements
- Changing your email now needs you to confirm the new address.
- Your light/dark theme follows you across devices.
- Time zone picker in Settings.

## 📦 Upgrade
```bash
docker compose pull && docker compose up -d
```

**Full changelog:** https://github.com/lyfie-org/papyra/compare/v0.1.22...v0.1.23
````

---

## v0.1.22

````markdown
## 🚀 New features
- **Admin account controls.** Admins can suspend or restore accounts.
- **Choose your notifications.** Pick which emails and alerts you get.
- **GitHub backup guide.** Step-by-step setup for backing up to GitHub.

## ✨ Improvements
- Lots of small UI polish on cards and menus.

## 📦 Upgrade
```bash
docker compose pull && docker compose up -d
```

**Full changelog:** https://github.com/lyfie-org/papyra/compare/v0.1.21...v0.1.22
````

---

## v0.1.21

````markdown
## 🚀 New features
- **Delete your account.** Removes your account and all your notes, with a confirmation step.
- **Safer export.** Exporting your notes now asks you to confirm it's you first.
- **Link cards.** Links in notes show a preview card with title and image.
- **Media on cards.** Pictures and videos show on note cards, with tools to manage them in the note.
- **Outline in focus mode.** A table of contents for the note you're writing.

## ✨ Improvements
- Emails are now proper, nicely formatted HTML.

## 📦 Upgrade
```bash
docker compose pull && docker compose up -d
```

**Full changelog:** https://github.com/lyfie-org/papyra/compare/v0.1.20...v0.1.21
````
