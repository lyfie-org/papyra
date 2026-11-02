# Maintaining Papyra

How issues and pull requests move through the repo. Everything here is driven by
files in `.github/`, so changing the process means editing a file, not clicking
through GitHub settings.

## The life of an issue

1. **Opened** from a form (bug, feature or task). Blank issues are off; questions
   are sent to Discord. The form adds `type: *`, `needs: triage` and an `area: *`
   label.
2. **Triage** (a few minutes, once a day or so). For each `needs: triage`:
   - Can't reproduce or missing detail → `needs: info` and ask. It closes after 21 quiet days.
   - Duplicate → comment the original, label `duplicate`, close.
   - Not a fit → `wontfix` with a kind reason, close.
   - Accepted → swap `needs: triage` for `status: confirmed`. Add `priority: high`
     only for data loss or a broken core flow.
   - Needs a decision before anyone codes → `needs: design`.
3. **Make it takeable.** If someone else could build it, give it `help wanted`
   (and `good first issue` if it's small and well described). Rewrite the body as a
   *Development task* with a goal, where to look and a "done when" checklist. A
   vague issue is not takeable.
4. **Claimed.** A contributor comments `/take`. The workflow assigns them, adds
   `claimed`, drops `help wanted`. `/untake` reverses it. If a claim goes quiet for
   a few weeks, ask; if no answer, unassign by hand.
5. **Pull request** to `development`. The PR gets `pkg: *` labels from its files and
   a title check. Merge when CI is green and you've read the change.
6. **Closed** by `Closes #n` in the PR.

## Labels

Defined in `labels.yml` and synced by the *Sync labels* workflow. Three families:

| Family | Labels | Set by |
|---|---|---|
| Kind | `type: bug`, `type: feature`, `type: task`, `type: docs`, `type: chore` | issue form |
| Where in the product | `area: editor`, `todo`, `journal`, `sharing`, `collab`, `search`, `auth`, `import-export`, `api`, `ops`, `site` | form dropdown |
| Where in the code | `pkg: api`, `web`, `collab`, `site`, `versions`, `ops`, `ci` | PR file paths |
| State | `needs: triage`, `needs: info`, `needs: design`, `status: confirmed`, `status: blocked`, `priority: high`, `claimed` | you |
| Contributing | `good first issue`, `help wanted` | task form, `/take` |

## Releases

Unchanged: see `RELEASE_LINES.md` and `RELEASE_TEMPLATE.md`. Release notes are
written by hand per version in `release-notes/`.

## One-time repo settings (not expressible as files)

Settings → General: enable **Issues**; turn off **Wikis**; under *Pull Requests*
allow squash merging and enable **Automatically delete head branches**.
Settings → Actions → General: *Fork pull request workflows* → **Require approval
for first-time contributors**.
Settings → Branches: protect `main` (require the CI check, no force-push). Keep
`development` as the default branch for PRs if that's where contributors should
target.
Projects: create a board with columns *Triage → Backlog → In progress → Review →
Done* and turn on its built-in workflows to auto-add new issues and move them when
closed or merged. Pin 2–3 `good first issue` tasks at the top of the issue list.
