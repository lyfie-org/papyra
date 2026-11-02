# Maintaining Papyra

How issues and pull requests move through the repo. It's driven by files in
`.github/`, so changing the process means editing a file.

## Labels

Ten, defined in `labels.yml` and synced by the *Sync Labels* workflow.

| Label | Meaning |
|---|---|
| `bug` · `enhancement` · `documentation` | What kind of issue. Set by the issue form. |
| `question` | Should have been a Discord question. Answer, point there, close. |
| `good first issue` | Small, well described, safe for a newcomer. |
| `help wanted` | Open for anyone. Removed while someone has claimed it. |
| `needs info` | Waiting on the reporter. Closes after 21 quiet days. |
| `duplicate` · `wontfix` · `invalid` | Closing reasons. |

Whether an issue is claimed is shown by its **assignee**, not a label.

## The life of an issue

1. **Opened** from a form (bug, feature or task). Blank issues are off; questions go to Discord.
2. **Triage** (a few minutes, now and then). Anything with no assignee and no response is untriaged:
   - Missing detail → `needs info` and ask.
   - Duplicate → link the original, `duplicate`, close.
   - Not a fit → `wontfix` with a kind reason, close.
   - Accepted → leave open. Someone else could build it? Rewrite it as a *Development
     task* (goal, where to look, "done when") and add `help wanted`, plus
     `good first issue` if it's small.
3. **Claimed.** A contributor comments `/take`: they're assigned and `help wanted` is
   dropped. `/untake` reverses it. If a claim goes quiet for a few weeks, ask, then unassign.
4. **Pull request** to `development`, title `type(scope): summary` (checked by CI).
   Merge when CI is green and you've read the change.
5. **Closed** by `Closes #n` in the PR.

## Releases

See `RELEASE_LINES.md` and `RELEASE_TEMPLATE.md`. Release notes are written by hand
per version in `release-notes/`.

## Discord feed

`workflows/discord.yml` posts to the lyfie.org Discord through one webhook per channel,
each stored as a repo secret. A missing secret just skips that channel.

| Trigger | Channel | Secret |
|---|---|---|
| `bug` label | `papyra-issues` (forum) | `DISCORD_WEBHOOK_ISSUES` |
| `enhancement` label | `papyra-ideas` (forum) | `DISCORD_WEBHOOK_IDEAS` |
| `help wanted` label | `papyra-contributing` | `DISCORD_WEBHOOK_TASKS` |
| Release | `papyra-releases` | `DISCORD_WEBHOOK_RELEASES` |

- Issue text comes from strangers: it only reaches the script through env vars and
  `jq --arg`, and every message sets `allowed_mentions` to nothing. Keep it that way.
- A webhook URL lets anyone post to that channel. If one leaks, delete it in Discord and
  make a new one.
- Releases made by `release.yml` use the default token, which never fires the `release`
  event, so that workflow dispatches `discord.yml` itself.
- Posts are one-way: closing an issue doesn't update its Discord post.

## One-time repo settings (not expressible as files)

- Settings → General: turn off **Wikis**; allow squash merging; enable **Automatically
  delete head branches**.
- Settings → Actions → General: fork PR workflows → **Require approval for
  first-time contributors**.
- Settings → Branches: protect `main` (require the CI check, no force-push).
- Optional: a Projects board (Backlog → In progress → Review → Done) with its built-in
  auto-add and auto-close workflows. Pin 2–3 `good first issue` tasks.
