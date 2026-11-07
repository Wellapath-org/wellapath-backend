# Operations: Render Rollback Boundary

> **Scope:** production backend `wellapath-backend-production` (`https://api.wellapath.org`) and
> staging `wellapath-backend-staging`. Written 2026-11-07. This page covers what is safe to
> roll back to and how. The full artifact procedure is `DEPLOYMENT.md` §7. Valid artifact
> targets are in the knowledge base's `docs/ROLLBACK_TARGETS.md` and
> `publication/published_artifacts_registry_v1.json`.
>
> Any rollback that changes what `/config` serves is a **clinical** change. It needs
> engineering-lead approval and a decision reference, the same as a forward release.

## 1. The rule

**Do not use Render's "Rollback" button on any production deploy whose commit predates
`fd7190b`.** Roll back by changing `/config` in the application instead (§4).

A Render rollback redeploys an old build of the code. The old code carries its own hard-coded
`/config` literal (`src/routes/config.ts`). That literal names R2 objects and sha256 hashes as
they were then. Some of those objects have since been deleted, and others were edited in place.
Render cannot know this. The deploy reports healthy, but devices start failing.

## 2. Safe and unsafe deploys

| Deploy commit                                                     | What its `/config` names                                             | Verdict                                                                                                                              |
| ----------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `fd7190b` (PR #39 merge, 2026-09-29) **and any descendant**       | facilities `1.2` (`94f162e4…7788`), HTTP 200, hash OK                | **Safe boundary.** This is the current `origin/production`                                                                           |
| `6cf642f` (PR #38 merge, 2026-09-21), the only earlier production | facilities `1.1` (`25684c71…2398`)                                   | **UNSAFE.** v1.1 was deleted from R2 on 2026-09-29 (404), so fresh installs get no facilities. It would also re-serve withdrawn data |
| `9749814` (2026-07-26) up to `fd7190b`, all in staging history    | facilities `1.1`                                                     | **UNSAFE**, for the same reason                                                                                                      |
| `7aa7ed2` up to `a01ffda` (2026-07-21)                            | kb 2.0 `b8a3c19e…`, rules 2.0 `b969b084…`                            | **UNSAFE.** The R2 bytes were edited in place and no longer match, so the app rejects them (KB registry: retired)                    |
| `a01ffda` up to `2e07473` (2026-07-21 to 07-22)                   | kb 2.1 `e5d9fd82…`                                                   | **UNSAFE**, for the same reason (KB commit `2a8ffaf`)                                                                                |
| Every other commit before `fd7190b`                               | superseded or pilot clinical sets, and pre-production-hardening code | **UNSAFE.** This is not the released clinical configuration, and the code lacks the PR #38 production profile                        |

Every production deploy before `fd7190b` (that is, `6cf642f`) references the deleted
`facilities.ng.v1.1.json`. A fresh install gets a 404 for it and has no facility data. Installs
that already cached v1.1 keep showing data that has been withdrawn. Older staging-only commits
fail for the other reasons in the table. **Treat everything before `fd7190b` as unsafe.**

**The boundary moves.** Each future `/config` change creates a new boundary if it retires an
object. After any `/config` change, re-check this table. A deploy is safe only if every URL its
`/config` names returns HTTP 200 now and hashes to the value it declares (§5, step 3).

### Check a commit before deploying or rolling back to it

```bash
git fetch origin
SHA=<candidate commit>
git merge-base --is-ancestor fd7190b "$SHA" && echo "at/after boundary" || echo "UNSAFE: predates fd7190b"
git show "$SHA:src/routes/config.ts" | grep -nE "url:|hash:"   # then verify each URL (§5, step 3)
```

## 3. Identifying the commit a Render deploy runs

`GET /version` returns only `{"version":"0.3.0","environment":"production"}`. It does **not**
report the commit, so the dashboard is the source of truth.

1. Render dashboard → service **`wellapath-backend-production`** → **Events** (the deploy
   history). Each deploy entry shows the short commit SHA and the commit message it built, and
   whether it is live.
2. Note the SHA of the **live** deploy, and of the deploy you might roll back to. Expand the
   commit if only the message is visible.
3. Resolve it locally with `git log -1 <sha>` and run the check in §2. Compare with
   `git rev-parse origin/production`. They should be equal. If they are not, production was
   deployed from a different commit than the branch says, and that must be recorded in
   `PROGRESS.md`.
4. Confirm the deploy's **Branch** is `production` (Settings → Build & Deploy) and record
   whether **Auto-Deploy** is on. It was recorded _Off_ on 2026-09-29. Re-confirm it, because
   it decides whether step 6 of §4 needs a manual deploy.

Exact dashboard labels can change. If they differ from this description, update this section.

## 4. Supported rollback: application-level `/config` revert

This is the PR #40 pattern (`chore/facilities-rollback-to-v1-0`, a draft prepared in advance).

1. Pick the target version from the **valid** list in the KB `docs/ROLLBACK_TARGETS.md`
   (facilities 1.0, kb 2.3 or 2.2, rules 2.1, token_dictionary 1.0, verified 2026-11-07).
   **Never** use facilities 1.1, kb 2.0, kb 2.1 or rules 2.0.
2. Open a PR to `develop` that edits only that artifact's block in `src/routes/config.ts`
   (version, url, hash, release_date). Update the frozen literals in the regression test and in
   the distribution baseline, as `DISTRIBUTION_BASELINE.md` describes. For facilities, PR #40
   already exists. Re-verify it is mergeable first (`DEPLOYMENT.md` §7.3).
3. CI green, then merge. Staging auto-deploys `develop`. Verify staging `/config` and every
   artifact hash.
4. Move production by **fast-forward only**: `git push origin <verified-develop-sha>:production`.
   Never use `--force`.
5. Trigger the Render production deploy (if Auto-Deploy is off) **of that new commit**. This is
   a forward deploy of new code, not the Render "Rollback" button.
6. Verify production (§5, step 3) and record the result in `PROGRESS.md` and in the workspace
   `CLINICAL_CHANGE_LOG.md`.

Roll forward again with a revert PR on `develop`, then repeat steps 3–6.

**Code-only defects** (unrelated to artifacts): revert the offending commit on `develop` with a
revert PR, then follow steps 3–6. The Render rollback button is acceptable **only** for a deploy
at or after `fd7190b`, and only after §2's check passes for that deploy's commit, at that moment.

## 5. Checklist

Before:

- [ ] Reason and decision reference recorded. Engineering lead approval is in hand.
- [ ] Live deploy commit identified in the Render dashboard (§3) and equal to `origin/production`.
- [ ] Target chosen from the valid list only. Clinical compatibility of the resulting set of
      versions is checked with a case-bank run, and recorded.
- [ ] Rollback path is a `/config` PR (§4), **not** the Render rollback button. If a Render
      rollback is proposed for a code-only defect: the target deploy commit is at or after
      `fd7190b`, and every URL in its `/config` passes step 3 below.

During:

- [ ] PR touches only the intended `/config` block plus its frozen test and baseline literals.
- [ ] `npm ci && npm test` green (676 tests at 2026-11-07) and `npm run build` succeeds.
- [ ] Staging `/config` verified, with several cache-busted reads.
- [ ] `production` moved by fast-forward only. The Render deploy is of the new commit.

After (step 3, run against staging, then production):

```bash
API=https://api.wellapath.org
curl -s "$API/version"
curl -s "$API/config?cb=$RANDOM" > cfg.json
python3 - cfg.json <<'EOF'
import hashlib, json, sys, urllib.request
cfg = json.load(open(sys.argv[1]))
def walk(node):
    if isinstance(node, dict):
        if "url" in node and "hash" in node:
            yield node
        for value in node.values():
            yield from walk(value)
failed = 0
for item in walk(cfg):
    name = item["url"].rsplit("/", 1)[-1]
    request = urllib.request.Request(item["url"], headers={"User-Agent": "curl/8"})  # R2 403s urllib's default UA
    try:
        data = urllib.request.urlopen(request, timeout=60).read()
    except Exception as error:
        failed += 1
        print("FAIL", name, error)
        continue
    ok = "sha256:" + hashlib.sha256(data).hexdigest() == item["hash"]
    failed += not ok
    print("OK  " if ok else "FAIL", name, len(data), "bytes")
sys.exit(1 if failed else 0)
EOF
```

- [ ] `/version` gives `0.3.0` / `production`.
- [ ] Every artifact prints `OK`. Any `FAIL`, or any HTTP error: roll forward immediately.
- [ ] Result, commit, time and approver recorded in `PROGRESS.md` and in `CLINICAL_CHANGE_LOG.md`.
