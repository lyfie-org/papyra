# Changelog

All notable changes to Papyra are documented here. This file is updated
automatically by the **Release** workflow on every deployment; each entry maps to
a Docker Hub tag and a GitHub Release.

<!-- new releases are inserted directly below this line -->

## [0.3.8] - 2026-10-07

- chore: bump @lyfie/luthor to 2.11.3; drop the list-bullet override (e08d643)
- style(site): warm-steel hero phone with a soft screen glare; drop the window hover effect (f7b25fe)
- feat(site): typewriter headline, larger hero preview, roadmap order, footer polish (25ef024)
- feat(site): live hero slideshow, docs search and contents, growing vine, polish (c0c6853)
- feat(site): split hero, privacy and backups sections, roadmap, star CTA; self-host app fonts (9a129d7)
- feat(site): styled home page with real-app clips, journey timeline and contributing guide (31fe660)

## [0.3.7] - 2026-10-07

- fix: show where search hits live, stop PWA card pile-up, touch-friendly cards (ac38629)
- chore: cleanup docker compose instructions (ddc25b7)

## [0.3.6] - 2026-10-06

- feat: smoother first sign-in and a PWA that catches up on resume (2f7286a)

## [0.3.5] - 2026-10-06

- Update tokens.css (1c9becc)
- fix: match shared-note spacing to the editor, unify dark card rail (4645cdc)

## [0.3.4] - 2026-10-06

- chore: bump luthor to 2.11.2 for uniform pasted line heights (75921eb)
- fix: keep the unsaved draft in History before Review adopts an outside revision (485b790)

## [0.3.3] - 2026-10-02

- fix: prune deleted notes from search on cold boot even without a cache row (6efa1ca)
- fix: never let autosave or the snapshot throttle lose an external revision (3b2ddea)
- fix: adopt .md files created outside Papyra without an id (b5b0695)
- fix: conflict resolver diff rows collapsing into narrow columns (53b84db)

## [0.3.2] - 2026-10-01

- feat: focus-mode bottom bar, shared notes sort in with yours (4ab06df)
- feat: encrypt locked notes at rest (fa092d9)

## [0.3.1] - 2026-10-01

- fix(web): extract [[…]] embeds in one pass (was quadratic on unclosed runs) (2cd30c3)
- feat: tidier media bar, shared-note rename + personal pin, mobile drawer (d033635)
- ci: run only the jobs a push touches; faster installs and caches (6a3bd07)

## [0.3.0] - 2026-10-01

- feat: performance budgets, fuzzing, HEIC thumbnails, docs (d92c043)
- feat: attachment text queue, safe body writes, safe imports, streamed export (880680b)

## [0.2.6] - 2026-09-30

- feat: inline PDF preview on file cards (28bcd50)
- feat(: upload UX — limits pre-check, video posters, HEIC, offscreen pause (19b96ce)
- feat: adopt luthor 2.11.1 — thumbnails, batched metadata, no theme remounts (4cf0cef)
- feat: S1 backend foundation — streaming uploads, thumbnails, metadata (f5beed9)
- test: bring edge harness up to date with step-up, vault PIN and SSO routes (9d59160)
- feat: security hardening for attachments (3946670)

## [0.2.5] - 2026-09-29

- test: end-to-end coverage for SSO, share views, error pages, comments (bf31db7)
- fix(sso,shares): SSO challenge 500, view-once links; feat: note comments, error pages, joining preview (16d12e3)

## [0.2.4] - 2026-09-29

- feat: multiple SSO providers, renames, real client IPs, windowed notes grid (9c97de0)
- fix(sso): existing accounts only, readable failures; refresh server version on reconnect (fd64228)

## [0.2.3] - 2026-09-29

- fix(sso): send the public-URL redirect_uri to the identity provider (991c94c)

## [0.2.2] - 2026-09-29

- feat: show-then-edit settings, multiple authenticators, one session per browser (7d01628)

## [0.2.1] - 2026-09-29

- test(e2e): enrol the provisioned grantee's authenticator (32cf460)
- feat: two-step sign-in, signed-in devices, guided SSO, email logo (155e9d0)

## [0.2.0] - 2026-09-29

- feat(collab): open live notes offline from the device copy (03f37e1)
- feat(collab): C5 hardening — ticket rate limit, engine stats, docs (bb7129f)
- feat(collab): lifecycle hardening — restore-while-live, history attribution, lazy client (689c7eb)
- feat(collab): live editing in the web app — room binding, presence, cursors (e11a4ea)
- feat(collab): embed the live-editing engine in the API process tree (b5b970b)
- feat(collab): embedded collab engine package (Hocuspocus + headless luthor) (539fbd3)

## [0.1.24] - 2026-09-28

- feat: authenticator compulsory for the first admin (379ccf4)
- feat: authenticator-app codes, in-place wikilinks, calmer settings (a7405de)

## [0.1.23] - 2026-09-28

- Update tokens.css (635e8b2)
- feat: guided first-run setup, encrypted GitHub backup, verified email change (0aa4dd2)

## [0.1.22] - 2026-09-28

- chore: lint fix (1b52cf9)
- Revert "chore: lint fix" (1cb476c)
- chore: lint fix (b38ef5f)
- feat: admin account controls, notification catalog, GitHub backup guide, UI polish (a104773)

## [0.1.21] - 2026-09-28

- feat: guarded export + account deletion, HTML emails, media tools, link cards, dock outline (e2f4aa8)

## [0.1.20] - 2026-09-28

- fix: use the system text cursor instead of the drawn I-beam (4568cff)
- feat: shared-with-me page, readable note file names, one-view links that survive, to-do card actions (6d6b068)

## [0.1.19] - 2026-09-28

- feat: passkey sign-in, settings/profile overhaul, autofill hygiene, search rebuild job (79ae643)

## [0.1.18] - 2026-09-28

- fix: UI polish — neutral caret/focus/hover edges, themed dropdowns, share user picker (bab9a17)

## [0.1.17] - 2026-09-27

- feat: note-length-relative card heights; bump @lyfie/luthor to 2.10.3 (0f667c3)
- feat: shared notes on the desk, "Shared with me" filter, one-row header (6f9006e)
- fix: let editor menus see clicks inside the open note (3ff7368)
- feat: notifications tray, shared-with-me as a page, note-card parity (42c083c)

## [0.1.16] - 2026-09-27

- feat: whole-note sharing on mention + request edit access (6f345d2)

## [0.1.15] - 2026-09-27

- chore: bump @lyfie/luthor to 2.10.2 (3385fad)
- feat: Papyra-owned grouped toolbar, distinct palette, insert e2e (aab4350)

## [0.1.14] - 2026-09-27

- fix: end-to-end WCAG 2.2 AA pass and check:a11y harness (7cd140b)

## [0.1.13] - 2026-09-27

- feat: formatting toolbar toggle and "always show" preference (4d25bc6)
- feat: borderless canvas, top rule, full-width footer (bf60145)

## [0.1.12] - 2026-09-27

- ci: trigger workflows on push only (2df42f2)
- feat: highlight query matches in search results (e75d2ce)

## [0.1.11] - 2026-09-25

- chore: bump @lyfie/luthor to 2.9.8 (a56690e)
- feat: multi-select in Archive and Trash; keep blank lines and literal text (d622c6c)

## [0.1.10] - 2026-09-25

- feat: multi-select with bulk pin, archive, share, delete and group drag (1fdad4c)

## [0.1.9] - 2026-09-25

- fix(import): set creation time before mtime; skip it on Linux (bf02e74)
- feat: app-wide progress feedback + smooth grid reflow on resize (a9d313b)
- feat: Keep/Obsidian import with re-import dedupe + resumable progress (2388882)
- chore: sync design tokens (--on-photo) (99bba76)
- fix: opening a note no longer re-saves it; one-click delete; sticky manual order (04426fe)
- feat: editable username/name/email; personal ring-free avatars; free-framing cropper (a833893)

## [0.1.8] - 2026-09-25

- feat: unified in-editor version History; distinct versions only; luthor 2.9.7 (c4e7f03)
- fix: undo no longer reverts a note to raw source; previews read empty list items (71f54c7)

## [0.1.7] - 2026-09-25

- feat: Collections page absorbs tags; live smart collections on the desk (94dea76)

## [0.1.6] - 2026-09-24

- fix: share/confirm dialogs escape the card grid; deflake observer debounce test (21cd23f)
- feat: mandatory vault PIN, optional biometrics, and secure-note hardening (0797d57)

## [0.1.5] - 2026-09-24

- feat: formatted card previews; smooth theme and colour changes (a647a4a)

## [0.1.4] - 2026-09-24

- fix: masonry To Do grid, solid selection toolbar on coloured notes (e7b09f9)
- switch the assistant's checks on the feature flag (09ed046)

## [0.1.3] - 2026-09-22

- feat: hold the assistant back for a later release (c205138)
- feat: app website development (58ca194)
- fix: cloudlare deploy fix (bbf664b)
- fix: lint error cleanup + gitignore update (75b2a4f)
- feat: product website at papyra.app with an in-browser demo (01bc21f)

## [0.1.2] - 2026-08-20

- Update docker-compose.hub.yml (2bab849)
- feat: environment variables you can read, and a session that survives plain http (fae077d)

## [0.1.1] - 2026-08-20

- feat: links find notes by filename, dead links say so, and a note can be shared while open (53a85d9)
- fix: a mention delivers wherever it was written, and the assistant panel stops guessing (b0f5cd3)
- feat: test cases updated (02bb5f5)
- feat: say which model is answering, and let an admin pick another (2b3b984)
- feat: see what Papyra does in the background, and start it yourself (fdebdd2)
- feat: the heatmap moves to Settings, and a day opens instead of filtering (b6816d4)
- feat: crop your picture to a square (2054ee5)
- feat: a shared note says so, and says who to and a mention can offer the note, and a locked note can't be shared at all (ebc4ac8)
- feat: accounts get their own page, and their own password, search everything, not only notes (cd87333)
- fix: replace browser dialogs, fix search snippets, card spacing and note close (e458192)
- fix: stop cross-account data leaking through the browser and git sync (66bf3da)
- feat: explain every empty section instead of stating the obvious (9571e99)
- feat: one-click local models, plain-language UI, search overlay fix (74b99b6)
- feat: multi-provider AI (Ollama/OpenAI/Anthropic) with model download (33827f4)
- fix: luthor version bump + multi-tenancy (7e1e1c9)
- fix: scope NoteCache and the search index per tenant (495c024)
- feat: hard-tested for production readiness, functional testing pending (22d2e4e)
- chore: upgrade to @lyfie/luthor 2.9.1 and adopt its change API (2dc8e57)
- feat: performed testing and edge case resolution (ba2b82c)

## [0.1.0] - 2026-08-07

- fix: test case cleaned up (4c09fa3)
- fix: test case updated (7519e14)
- fix: CI warnings addressed (9994b2a)
- fix: lint fix (38c23ae)
- feat: passkey setup for encrypted notes (4c993c9)
- feat: local semantic rag (ollama embeddings + chat) (c03dcd4)
- feat: local vector embedding pipeline for semantic search (d9ff3a7)
- feat: webauthn-gated secure notes with reactive blur (e87f5b4)
- feat: webauthn gatekeeper + ephemeral unlock tokens (f34e8b6)
- feat: knowledge heatmap + rule-based smart collections (c220101)
- feat: knowledge heatmap of note activity (4c0c98f)
- feat: drag-drop quick-import + native libgit2sharp sync (e08307c)
- feat: drag-drop quick-import of md/txt notes (308e1be)
- feat: local tesseract ocr + distraction-free focus mode (01caa98)
- feat: local tesseract ocr for images (d705208)
- feat: local whisper transcription + web archiver + signed webhooks (c3b794d)
- feat: ssrf-guarded read-it-later web archiver (c49e8ee)
- feat: local whisper audio transcription (4fd09da)
- feat: cron cleanup for expired/exhausted share links (32dba17)
- feat: oidc sso login with jit user provisioning (edb6e6b)
- feat: ghost-card backlinks + time-machine scrub + toc scrollbar (bf1fb82)
- feat: time-machine snapshot scrubber in the editor (be0511f)
- feat: docs portal (16319f2)
- feat: accept X-API-Key header for personal access tokens (bad57ed)
- feat: aes-gcm encrypted backups — generate + restore (ded1629)
- feat: click + drag logic fixed (a66d4b0)
- feat: notes UX overhaul — ordering, sharing, categories, to-dos, settings (65f39df)
- fix: minor ui changes per description below (97d3409)
- feat: integrate PapyraEditor preset (luthor 2.9.0) + media serve endpoint (3cf4b9d)

## [0.0.1] - 2026-06-17

- feat: updating dockerignore (e03babe)
- fix: track EF source, isolate dev data dir, rework workflows for v1 (9efed05)
- fix: commit untracked EF source + rework workflows for v1 (ba8c86d)
- feat: ci/cd rework workflows for v1 — CI gate + one-button Docker Hub release (aebf17a)
- feat: preserve foreign frontmatter on import + finish v1.0 hardening (e7c1fa6)
- chore: hardening dev-gate API docs, strict prod CORS, fix container boot (3651b27)
- feat: PUID/PGID entrypoint + privilege drop for self-hosters (af43385)
- feat: emit Vite bundle into API wwwroot for single-process serve (59d51e5)
- feat: obsidian/keep importers + zip export (5f11488)
- feat: sync-conflict detection + split-pane resolver (182d187)
- feat: note snapshots + version history & recovery UI (1585925)
- feat: frontend auth guard + setup/login screens + admin user mgmt (470597b)
- feat: chroot path-jail — per-user vault roots + PathGuard + per-tenant watchers (76b6cdd)
- feat: cookie sessions + login/logout + [Authorize] guardrails (bae568e)
- feat: init gate + first-admin setup endpoint (bcrypt) (8ce3d48)
- feat: media dropzone upload + ![[filename]] insertion (1614f14)
- feat: note toolbar + palette picker + archive frontmatter (3fa5297)
- feat: caret-safe remote sync + conflict banner (c2b94a0)
- feat: luthor canvas + debounced autosave (a4b810c)
- feat: tanstack query + signalR live note hydration (cf8f911)
- feat: masonry note grid + cards w/ pinned split (58abf1d)
- feat: router shell + workspace layout w/ navbar + collapsible sidebar (9d0efea)
- feat: cold-boot diff + rebuild/prune housekeeping (0b8e4b1)
- feat: lucene full-text index + /api/search endpoint (32049f5)
- feat: notes CRUD endpoints + debounced SignalR bridge (7cf149c)
- feat: filesystem watcher + write-ring + debouncer vault sync (ea59ff2)
- feat: atomic markdown engine + EF/SQLite cache foundation (9a86da0)
- feat: EF Core + SQLite relational cache foundation (5a56846)
- feat: barebones app overhaul prep (3cee184)
- Update deploy.yml (54bd2e1)
- Update deploy.yml (53d05a3)
- chore: cleaning up pipelines (f0aae5c)
- Update deploy.yml (b4a3c37)
- chore: smoke test before deploy + backend ci workflow fix (77459b6)
- Update Dockerfile (57eac49)
- Update .dockerignore (6d54b6e)
- Update Dockerfile (d44a4e5)
- Update deploy.yml (0e7c044)
- chore: cleaned up api test cases for github CI compatibility (d8f6e22)
- Update HappyPathTests.cs (eccd398)
- Update NoteSearchIntegrationTests.cs (10e6c09)
- Update NoteAuthzTests.cs (fdd4e3f)
- chore: api test cases cleaned up (4b41a4b)
- Update NoteAuthzTests.cs (26b22b2)
- chore: backend testcases dev (8983372)
- chore: cleaning up unused variables (a2e42b6)
- chore: cleaning up pnpm/npm configuration ci/cd (0128268)
- chore: sync package-lock with package.json (d4f8d5a)
- feat: baseline papyra workflow implementation (aaaa6ae)
- feat: major ui overhaul (29b3d12)
- feat: production-readiness audit — backend hardening, a11y, Docker (832e0bb)
- feat: upgrade storage, and implement Google Keep UX (13c98fd)
- feat: styling colors updated (4e7d62c)
- feat: build React SPA with real-time SignalR sync and rich text editor (97fdee4)
- Add solution scaffold, Note model, MarkdownStorageService, and CI workflow (6592a5b)
- Initial commit (eb5ac36)
