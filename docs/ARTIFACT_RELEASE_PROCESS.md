# Artifact Release Process

> The versioning checklist followed throughout the build. This documents the process **as
> actually practised** across releases in E5, E7, and E8 — not an aspirational one.

---

## 1. The Governing Rule

> **All artifact changes must be versioned. Never overwrite an existing artifact version.**
> — `CLAUDE.md` §0, Non-Negotiables

Every artifact version is immutable once published. Changed content means a **new version
string, a new filename, and a new hash** — always. An artifact already downloaded and cached by
a mobile client must never change underneath it.

This rule is enforced in three places:

1. **Process** — the checklist below
2. **Database** — `artifact_versions` carries `UNIQUE (artifact, version)`
3. **Review** — the backend engineer verifies before wiring anything into `/config`

---

## 2. Roles

| Role             | Owns                                                                 |
| ---------------- | -------------------------------------------------------------------- |
| Data engineer    | Artifact content, version bump, filename, SHA256, upload to R2       |
| Engineering lead | Approves the release; relays the version + URL + hash to the backend |
| Backend engineer | Independently verifies, then wires the block into `/config`          |

**The backend engineer does not author artifact content and does not generate its hash.**
The backend's job is to verify and distribute.

---

## 3. Release Checklist

### Data engineer

- [ ] **Bump the version string inside the file first** — `_metadata.version` must match the
      version the file will be published as. An internal/external mismatch is a release defect.
- [ ] **Rename the file to match the new version** — `kb.ng.v2.4.json`, `rules.ng.v2.2.json`,
      `facilities.ng.v1.1.json`, `token_dictionary.ng.v1.1.json`
- [ ] **Update `_metadata.release_date`**, and add a patch note describing what changed
- [ ] **Generate the SHA256 hash** — `shasum -a 256 <file>`
- [ ] **Upload as a new file — never overwrite an existing object**
- [ ] **Confirm the previous version still returns HTTP 200** on R2
- [ ] **Report the version, URL, hash, and release date to the engineering lead**

### Engineering lead

- [ ] Approve the release and relay the artifact block to the backend engineer

### Backend engineer — verify before wiring

**`/config` is updated only after the lead confirms the release.** Before touching
`config.ts`:

- [ ] **Fetch the file directly from R2** and confirm HTTP 200
- [ ] **Recompute the SHA256 locally** and confirm it matches the supplied hash **exactly** —
      never copy a hash into `config.ts` without independently reproducing it
- [ ] **Confirm every prior version still returns HTTP 200** with its original hash — proves no
      overwrite occurred
- [ ] **Diff the new version against the previous one** and confirm the change matches what was
      described — nothing else changed silently
- [ ] **Validate referential integrity** — every token referenced by the KB or rules must exist
      in the `token_dictionary` version being served
- [ ] Update only the affected block in `src/routes/config.ts`; leave the other artifacts alone
- [ ] Run `npm run lint`, `npm run format:check`, `npm run build`
- [ ] Open a PR against `develop` recording the verification evidence in the description
- [ ] Merge once CI is green, then **verify staging `/config`** returns the new version with the
      matching hash
- [ ] Confirm back to the engineering lead
- [ ] Update `PROGRESS.md`

---

## 4. Verification Commands

```bash
# Fetch and hash the new artifact
curl -sS -o new.json -w "HTTP:%{http_code} bytes:%{size_download}\n" \
  https://pub-8bc2ba0d7e7647799d89662d70f23c45.r2.dev/kb.ng.v2.4.json
shasum -a 256 new.json     # must match the supplied hash exactly

# Confirm the previous version is untouched
curl -sS -o old.json -w "HTTP:%{http_code}\n" \
  https://pub-8bc2ba0d7e7647799d89662d70f23c45.r2.dev/kb.ng.v2.3.json
shasum -a 256 old.json     # must still match the hash currently in config.ts

# Verify staging after deploy
curl -sS https://wellapath-backend-staging.onrender.com/config
```

---

## 5. Why the Independent Verification Step Exists

This is not ceremony. Each check below exists because of a specific incident:

| Check                          | Incident that motivated it                                                                                                                                                                                                                                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Never overwrite a version      | **PR #16 (E7).** `knowledge_base` and `rules` shipped as v2.0; a follow-up then asked to change the v2.0 hashes while keeping the same version string and filename. Flagged as an overwrite violation and held. The lead confirmed it was an error, and the corrected content shipped as **v2.1** with new filenames. |
| Recompute the hash yourself    | A hash is the only integrity guarantee the mobile client has. A transcription error or a mismatched upload would ship a KB that fails on-device integrity checks for every user.                                                                                                                                      |
| Confirm prior versions are 200 | Directly proves no overwrite happened, rather than assuming it.                                                                                                                                                                                                                                                       |
| Diff against the previous file | **`rules` v2.2 (E8).** The file was _larger_ after a release that removed a rule. Benign once explained (an added metadata note), but chasing it produced the diff that confirmed the other 75 rules were byte-identical and nothing rode along.                                                                      |
| Validate token references      | **`rf_004`.** A red-flag rule referenced the token `unconsciousness`, which was absent from the token dictionary — a dead rule that could never fire. Caught by validation and removed.                                                                                                                               |
| Verify staging after deploy    | Merging is not shipping. `/config` is confirmed live before the release is reported complete.                                                                                                                                                                                                                         |

---

## 6. Scope Boundary

The backend repository is **Fastify + TypeScript only**. It does not contain:

- the Flutter mobile engine (`urgency_determiner.dart` and similar)
- any KB / rules generation pipeline
- artifact source content

A request to edit mobile source or regenerate artifact content is **out of scope for this
repo** and should be flagged and held, not improvised. This happened once during E7 — a Case 04
policy instruction addressed to the mobile and data engineers arrived in the backend session.
It was held rather than acted on, and the lead confirmed it was misdirected. The backend's role
was unchanged: wire `/config` once the data engineer delivers the verified hash.

---

## 7. Release History

| Release                                    | PR  | Note                                              |
| ------------------------------------------ | --- | ------------------------------------------------- |
| `facilities` v1.0                          | #15 | E5 — facilities added to `/config`                |
| `kb`/`rules` v2.0                          | #16 | E7 — later found to be an overwrite error         |
| `token_dictionary` v1.1, `kb`/`rules` v2.1 | #17 | E7 medical review fixes; corrected the v2.0 error |
| `kb` v2.2                                  | #18 | Red flag mirror fix                               |
| `kb` v2.3                                  | #19 | Malaria explanation template, Case 04 policy      |
| `facilities` v1.1                          | #20 | 45 Lagos facility phone numbers                   |
| `rules` v2.2                               | #22 | Dead rule `rf_147` removed (76 → 75)              |
| `kb` v2.4                                  | #23 | E8.2 calibration — `headache` token at weight 6   |

**Frozen for beta at:** `knowledge_base` v2.4 · `rules` v2.2 · `token_dictionary` v1.1 ·
`facilities` v1.1.
