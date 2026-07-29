# WellaPath Backend

WellaPath is a Clinical Decision Support System (CDSS). It is not a diagnosis engine.
This repository contains the Fastify + TypeScript backend that serves as the system spine —
distributing versioned clinical artifacts to the mobile app and exposing health, version,
and configuration endpoints.

**Stack:** Fastify · TypeScript · Node.js v20 LTS · PostgreSQL (Supabase) · Cloudflare R2 · Render

---

## Documentation

| Document                                                               | Covers                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------ |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)                             | Current stack, environment variables, rollback procedure, CI |
| [`docs/ARTIFACT_RELEASE_PROCESS.md`](docs/ARTIFACT_RELEASE_PROCESS.md) | Artifact versioning checklist and release history            |
| [`docs/SECURITY_CHECKLIST.md`](docs/SECURITY_CHECKLIST.md)             | Beta security posture, accepted risks, production gates      |

**Cross-repo engineering decisions** (E7–E8 clinical and engineering decisions spanning mobile,
knowledge-base, and backend) live in the `wellapath-docs` repository, in `decision-log.md` —
they are not backend-specific and are kept where every engineer can find them.

> ⚠️ `CLAUDE.md` Section 1 still documents the **superseded AWS infrastructure** (ECS, RDS, S3,
> CloudFront). The live stack is Render + Supabase + Cloudflare R2 — see
> [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) §2 for the mapping.

---

## Architecture

- The backend distributes versioned artifacts (knowledge base, rules, facilities) via URLs
- All scoring and triage logic executes on-device only — never on the server
- No symptom-level PHI is stored server-side under any circumstances
- The mobile app bootstraps by calling `GET /config` to retrieve artifact metadata

---

## Live Endpoints (Staging)

Base URL: `https://wellapath-backend-staging.onrender.com`

| Method | Path       | Description                                              |
| ------ | ---------- | -------------------------------------------------------- |
| GET    | `/health`  | Returns server status and database connectivity          |
| GET    | `/version` | Returns app version and current environment              |
| GET    | `/config`  | Returns versioned artifact metadata for mobile bootstrap |

### Example responses

**GET /health**

```json
{
  "status": "ok",
  "timestamp": "2026-05-17T10:00:00.000Z",
  "checks": { "database": "ok" }
}
```

**GET /version**

```json
{
  "version": "0.1.0",
  "environment": "staging"
}
```

**GET /config**

Current response as served by staging (artifact versions frozen for internal beta, E9.1):

```json
{
  "version": "1.0",
  "country": "ng",
  "artifacts": {
    "token_dictionary": {
      "version": "1.1",
      "url": "https://pub-8bc2ba0d7e7647799d89662d70f23c45.r2.dev/token_dictionary.ng.v1.1.json",
      "hash": "sha256:0cc47ad9537c0bd4c6ef3aec8f1931eb9b4c62103a8809d16544f94a90b5c019",
      "release_date": "2026-04-05",
      "country": "ng"
    },
    "knowledge_base": {
      "version": "2.4",
      "url": "https://pub-8bc2ba0d7e7647799d89662d70f23c45.r2.dev/kb.ng.v2.4.json",
      "hash": "sha256:6c00d8257f8417e86bd5e237630bf8a4623ad72e2e46b1b071dd447c067cec2b",
      "release_date": "2026-07-27",
      "country": "ng"
    },
    "rules": {
      "version": "2.2",
      "url": "https://pub-8bc2ba0d7e7647799d89662d70f23c45.r2.dev/rules.ng.v2.2.json",
      "hash": "sha256:1d27e854cba95b179577a88f92445400f494a7fe8e6a53a60fcaa98b3870d1c4",
      "release_date": "2026-07-26",
      "country": "ng"
    },
    "facilities": {
      "version": "1.1",
      "url": "https://pub-8bc2ba0d7e7647799d89662d70f23c45.r2.dev/facilities.ng.v1.1.json",
      "hash": "sha256:25684c714367abf2f3c305c8a5597b5f7eb0d11baaf658c5b9e2f8f5e2982398",
      "release_date": "2026-07-26",
      "country": "ng"
    }
  }
}
```

> The mobile app must always consume artifact URLs from this response — never construct
> R2 URLs directly. This is what makes artifact rollback possible without a mobile release.

---

## Local Development

### Prerequisites

- Node.js v20 LTS
- Git
- Git Bash (Windows — always use Git Bash, never PowerShell or CMD for git commands)

### Setup

```bash
# Clone and switch to develop
git clone https://github.com/Wellapath-org/wellapath-backend.git
cd wellapath-backend
git checkout develop

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Fill in DB_USER, DB_PASSWORD in .env — get values from team lead

# Start development server (port 3000)
npm run dev

# Run database migrations
npm run migrate
```

---

## npm Scripts

| Script                 | Description                                   |
| ---------------------- | --------------------------------------------- |
| `npm run dev`          | Start server with hot reload (ts-node)        |
| `npm run build`        | Compile TypeScript to dist/                   |
| `npm start`            | Run compiled output from dist/                |
| `npm run lint`         | Run ESLint                                    |
| `npm run lint:fix`     | Run ESLint with auto-fix                      |
| `npm run format`       | Format all files with Prettier                |
| `npm run format:check` | Check formatting without writing              |
| `npm test`             | Run test suite                                |
| `npm run migrate`      | Run database migrations against configured DB |

---

## Environment Variables

Copy `.env.example` to `.env` and fill in the required values. Never commit `.env`.

See `.env.example` for the full variable reference. Required variables include database
credentials (Supabase), artifact base URL (Cloudflare R2), and app version.

---

## Branch Strategy

| Branch      | Purpose                                     |
| ----------- | ------------------------------------------- |
| `main`      | Production — protected, PRs only            |
| `develop`   | Integration branch — always branch off here |
| `feature/*` | New features                                |
| `fix/*`     | Bug fixes                                   |
| `chore/*`   | Maintenance, config, dependency updates     |

**Never push directly to `main` or `develop`.** All changes go through pull requests.

```bash
git checkout develop
git pull origin develop
git checkout -b feature/your-feature-name
```

---

## Commit Convention

Commits are enforced by commitlint against the Conventional Commits spec.

```
type(scope): short description in lowercase
```

Valid types: `feat` `fix` `chore` `docs` `refactor` `test` `perf` `ci` `style` `revert`

Examples:

```
feat(health): add database connectivity check to health endpoint
fix(db): enable ssl for supabase connection
chore(infra): update env example after migration to supabase and r2
```

Rules: lowercase only · under 100 characters · no trailing full stop

---

## Non-Negotiables

These rules are absolute and enforced on every PR:

- **No PHI server-side — ever.** No symptom data, no patient identifiers, nothing.
- **No server-side scoring.** All triage and scoring logic runs on-device only.
- **No secrets in code.** All credentials via `.env` locally, Secrets Manager in production.
- **No direct pushes to `main` or `develop`.** Every change goes through a PR.
- **No feature additions outside locked MVP scope** without founder + engineering lead sign-off.
