# Engineering Decision Log — E7 / E8

> Key clinical and engineering decisions made during E7 (Knowledge Base & Rules) and
> E8 (Validation & Calibration), recorded ahead of the E9 internal beta.

---

## How to Read This Log

The decisions below are **clinical policy owned by the founder, the medical reviewer, and the
data engineer**. This backend repository distributes artifacts; it does not author them and
does not execute scoring.

Each entry is therefore marked with its evidence basis:

| Marker          | Meaning                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------- |
| 🔍 **Verified** | Confirmed directly against the published artifacts on R2 by this repo's engineer          |
| 📩 **Relayed**  | Recorded as stated by the engineering lead; the deciding artefact lives outside this repo |

Where a decision's _rationale_ was never recorded in this repo, that is stated plainly rather
than reconstructed. Those entries need an owner to fill in.

---

## D1 — SAM / MAM Split Policy

**Status:** 📩 Relayed — **rationale not recorded in this repo**

**What is observable in the artifacts** (🔍 verified against `kb.ng.v2.4.json` and
`token_dictionary.ng.v1.1.json`):

- The token dictionary carries two distinct demographic tokens:
  `severe_malnutrition_sam` and `moderate_malnutrition_mam`
- There is a single `malnutrition` condition, with `urgency_default: urgent` and
  `base_weight: 6`
- `moderate_malnutrition_mam` appears as a demographic modifier on other conditions
  (for example `acute_diarrhoea`), where it raises urgency

So the split is real and is expressed as **two demographic tokens rather than two separate
conditions** — MAM and SAM modify urgency as patient context, rather than each having its own
condition entry.

**Gap:** the clinical reasoning for the split, the thresholds separating SAM from MAM, and why
it was modelled as tokens rather than conditions are **not documented anywhere in this
repository**. This entry records the mechanism, not the decision.

> **Action required:** data engineer or medical reviewer to supply the policy rationale and
> thresholds so this entry can be completed before beta sign-off.

---

## D2 — Case 04: Option B (`children_under_5` + rainy season → URGENT)

**Status:** 📩 Relayed (founder decision) · 🔍 downstream artifact change verified

**Decision:** the compound modifier `children_under_5` + `rainy_season` routes to **URGENT**,
not EMERGENCY (Priority 4c).

**Backend-side record:**

- The instruction to implement this arrived in the backend session but was addressed to the
  **mobile and data engineers** — it called for edits to `urgency_determiner.dart` and a KB
  content regeneration. Neither exists in this repository (Fastify/TypeScript only; no `.dart`
  files, no KB generation pipeline). It was **flagged and held rather than improvised**, and the
  lead confirmed it was misdirected.
- The resulting KB content change was delivered by the data engineer as **`kb.ng.v2.3.json`**,
  updating the malaria `explanation_template` to URGENT-appropriate caution language for
  under-5s in rainy season. Wired into `/config` in **PR #19** after the hash was independently
  verified against R2.

**Where the decision actually lives:** the mobile urgency engine and the KB source content.
Not enforced by this backend.

---

## D3 — Malaria `base_weight` Kept at 10

**Status:** 📩 Relayed (decision) · 🔍 **verified in the frozen artifact**

Confirmed directly in `kb.ng.v2.4.json`:

```
condition_id:      malaria
base_weight:       10
urgency_default:   urgent
```

`base_weight: 10` is the highest base weight in the knowledge base. Malaria's default urgency
is `urgent` before any symptom scoring occurs.

**Open monitoring item — Issue #38:** malaria `base_weight` behaviour in _mixed presentations_
(where malaria-consistent symptoms co-occur with another condition's symptoms) is under
observation, not resolved. A high base weight makes malaria a strong attractor in ambiguous
cases. Carried into beta as monitored, not blocking.

---

## D4 — Headache Token at Weight 6 (Routing Accepted)

**Status:** 🔍 **Verified** — E8.2 calibration, shipped as `kb.ng.v2.4.json` (PR #23)

**Decision:** add the literal `headache` token to the `headache` condition at **weight 6**
(Issue #8, Option A).

**Problem it solved — reachability.** The `headache` token was already referenced in the
condition's `severity_levels` (mild / moderate / severe) but was **absent from `symptoms[]`**,
so it carried no scoring weight. A user reporting plain "headache" contributed nothing to the
headache condition's score.

**Verified state after the change** (`kb.ng.v2.4.json`):

```
condition_id:     headache
base_weight:      5
urgency_default:  self_care
symptoms:
  head_pain              weight 6
  throbbing_headache     weight 5
  pressure_headache      weight 4
  one_sided_headache     weight 5
  headache               weight 6   ← added in v2.4
red_flags:  neck_stiffness_fever, altered_consciousness
```

The diff was confirmed to be exactly this one addition — all 49 other conditions were
byte-identical to v2.3, and `headache` was confirmed present in the `symptom_tokens` list of
the served `token_dictionary` v1.1.

**⚠️ Open observation raised by this repo, not yet resolved.** The condition now carries both
`head_pain` (weight 6) and `headache` (weight 6). If the on-device tokenizer maps a single user
report of "headache" onto **both** tokens, the condition scores 12 from what is clinically one
symptom, on top of `base_weight: 5`. This may be intended under Option A. Scoring executes
on-device and is outside this repo's scope, so it was flagged rather than blocked at release
time.

This is related to but distinct from **Issue #42** (headache routing at population scale,
monitored into beta). Issue #42 tracks aggregate routing behaviour; this tracks a possible
double-count in a single assessment.

> **Action required:** E8.2 calibration owner to confirm the double-count is deliberate.

---

## D5 — `increase_urgency` Is a No-Op on Already-Urgent Conditions

**Status:** 📩 Relayed (Issue #36, documented not fixed) · 🔍 **scope quantified here**

**Behaviour:** a demographic modifier with `effect: increase_urgency` has no effect when the
condition's `urgency_default` is already at or above the ceiling that effect can raise it to.
Escalation beyond `urgent` is reserved for red-flag override.

**Scope, measured against the frozen `kb.ng.v2.4.json`** — 30 conditions carry at least one
`increase_urgency` modifier:

| Group                                             | Count  | Effect                                   |
| ------------------------------------------------- | ------ | ---------------------------------------- |
| `urgency_default` already `urgent` or `emergency` | **19** | Modifier is inert — no observable effect |
| `urgency_default` is `self_care` or `non_urgent`  | **11** | Modifier escalates as intended           |

Conditions in the inert group include `malaria` (3 modifiers), `tuberculosis_suspected` (3),
`dysentery` (2), `typhoid_fever` (2), `measles` (2), and the emergency-default conditions
`cholera`, `lassa_fever`, `vhf_suspected`, and `csm`.

**Why this is acceptable for beta:** the failure mode is a modifier that does nothing, on
conditions that are _already_ routed urgent or emergency. It cannot cause **under-triage** — the
direction that matters clinically. It is redundancy, not a safety gap.

**Risk to be aware of:** those 19 conditions' modifiers read as if they do something. Anyone
tuning calibration from the artifact could reasonably assume `malaria` + `pregnancy` escalates
beyond the default when it does not.

Documented, not fixed, per Issue #36.

---

## D6 — Dead Rule `rf_147` Removed (`rules` v2.2)

**Status:** 🔍 **Verified** — shipped in PR #22

`rf_147` was removed from the rules artifact (76 → 75 rules). Verified as **behaviourally
inert** before merge rather than accepted on the release note:

|                    | `rf_147` (removed)          | `rf_006` (retained)    |
| ------------------ | --------------------------- | ---------------------- |
| token              | `circulatory_collapse`      | `circulatory_collapse` |
| `override_urgency` | `emergency`                 | `emergency`            |
| `applies_to`       | `road_traffic_injury_minor` | `all`                  |
| priority           | 11                          | **1**                  |

`rf_006` matches the same token for every condition, returns the same `emergency` override, and
outranks `rf_147`. `rf_147` could therefore never have been the winning rule. Removing it
weakens no red-flag path — `circulatory_collapse` still escalates to `emergency` for
`road_traffic_injury_minor`.

This mirrors the earlier removal of **`rf_004`**, which referenced the token `unconsciousness`
— absent from the token dictionary, so it could never fire. That case is why token-reference
validation is now a standing step in the release checklist.

---

## D7 — Artifact Immutability Enforced (Process Decision)

**Status:** 🔍 **Verified** — E7, PRs #16 → #17

`knowledge_base` and `rules` shipped as v2.0 in PR #16. A follow-up request then asked to change
the v2.0 hashes **while keeping the same version strings and filenames**.

This was flagged as a violation of the `CLAUDE.md` non-negotiable _"never overwrite an existing
artifact version"_ and work was held pending confirmation. The engineering lead confirmed the
v2.0 release was an error. The corrected content shipped as **v2.1** with new filenames
(`kb.ng.v2.1.json`, `rules.ng.v2.1.json`) and new hashes.

**Standing consequence:** every artifact release since has been verified against this rule —
new filename, new hash, and prior versions confirmed still live on R2. Every release in E8
passed. This is what makes artifact rollback viable (see `DEPLOYMENT.md` §7).

---

## D8 — Infrastructure Migration: AWS → Render / Supabase / Cloudflare R2

**Status:** 🔍 **Verified in code and live** · migration itself predates this log (E2–E4, PRs #12–#14)

The original AWS staging stack (ECS Fargate, RDS, S3, CloudFront, Secrets Manager) was replaced
by Render, Supabase PostgreSQL, and Cloudflare R2.

**Documentation debt this created:** `CLAUDE.md` — a locked build-law document — still describes
the AWS stack in Section 1, including account IDs, ARNs, and endpoints that are no longer in
use. Corrected in `DEPLOYMENT.md` §2 rather than edited in place, since changing `CLAUDE.md`
requires founder + engineering lead review.

> **Action required:** founder + engineering lead to approve an update to `CLAUDE.md` §1 so the
> build-law document stops pointing at decommissioned infrastructure.

---

## Summary of Open Actions

| #   | Action                                                                       | Owner                        |
| --- | ---------------------------------------------------------------------------- | ---------------------------- |
| 1   | Supply SAM/MAM split rationale and thresholds (D1)                           | Data engineer / med reviewer |
| 2   | Confirm `headache` + `head_pain` double-count is deliberate (D4)             | E8.2 calibration owner       |
| 3   | Approve update of `CLAUDE.md` §1 to current infrastructure (D8)              | Founder + engineering lead   |
| 4   | Decide whether the 19 inert `increase_urgency` modifiers are cleaned up (D5) | Engineering lead             |

None of these block beta. All four are documentation or clarity items, not defects.
