# WellaPath Backend — Claude Code Instructions

# Phase E1: System Spine | E1.1 Backend Init + E1.2 Core Endpoints

> **Senior Backend Engineer brief for Claude Code.**
> Read this entire file before touching any code.
> Every decision here is derived from three locked documents:
>
> - `Engineering_Workflow_Backlog.pdf` (build law)
> - `WellaPath_Developer_Onboarding_Guide.docx` (code standards)
> - `WellaPath_AWS_Infrastructure_Handover.docx` (infra truth)

---

## 0. NON-NEGOTIABLES (Locked Build Principles)

These are absolute. No exceptions. No PRs that violate these will be merged.

- WellaPath is a **CDSS — not a diagnosis engine**. Never represent it as one.
- **No symptom-level PHI stored server-side** under any circumstances.
- **Scoring logic executes on-device only** — never on the server.
- **All artifact changes must be versioned.** Never overwrite an existing artifact version.
- **Red flag override always takes priority** over scoring output.
- **No secrets hardcoded** in source code. All credentials via Secrets Manager or `.env`.
- **No feature additions outside locked MVP scope.**
- **No architecture changes** without founder + engineering lead review.
- **No phase blending** — complete E1 exit criteria before starting E2.

---

## 1. Repo & Environment Context

### Repository

```
Repo:    wellapath-backend
Remote:  https://github.com/Wellapath-org/wellapath-backend.git
Branch:  develop  ← always branch off here
Stack:   Fastify + TypeScript + Node.js v20 LTS
Runtime: AWS ECS Fargate (staging)
```

### Key AWS Staging Values (from Infrastructure Handover doc)

```
AWS Account ID:      812527292522
Region:              us-east-1
ECS Cluster:         wellapath-staging
ECR Repo URI:        812527292522.dkr.ecr.us-east-1.amazonaws.com/wellapath-backend
RDS Endpoint:        wellapath-staging-db.cclsme0gujar.us-east-1.rds.amazonaws.com
RDS DB Name:         wellapath_staging
RDS Username:        wellapath_admin
RDS Port:            5432
S3 Bucket:           wellapath-artifacts-staging
CloudFront Domain:   https://d179u2ex0g66o3.cloudfront.net
API Domain:          https://api-staging.wellapath.org
DB Secret ARN:       arn:aws:secretsmanager:us-east-1:812527292522:secret:wellapath/staging/db-dgHN1G
App Secret ARN:      arn:aws:secretsmanager:us-east-1:812527292522:secret:wellapath/staging/app-0rFlFx
Server Port:         3000  ← MUST match ECS security group rule
```

> **Never hardcode credentials.** Reference them via `.env` locally and via Secrets Manager ARNs in ECS task definitions.

---

## 2. Git & Branch Rules

```bash
# Always start from develop
git checkout develop
git pull origin develop
git checkout -b feature/e1-backend-init   # for E1.1
git checkout -b feature/e1-core-endpoints # for E1.2
```

**Branch naming:**

- `feature/e1-backend-init`
- `feature/e1-core-endpoints`
- `fix/scope-description`
- `chore/scope-description`

**NEVER push directly to `main` or `develop`.** All work goes through PRs.

---

## 3. Commit Message Rules (Conventional Commits — Enforced by Commitlint)

```
type(scope): short description in lowercase
```

- Lowercase only — this includes phase identifiers: write `e2.5`, `e1`, not `E2.5`, `E1`
- Under 100 characters
- No full stop at the end
- Commitlint will **block** non-compliant commits automatically

**Valid types:** `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `ci`, `style`, `revert`

**Examples for this phase:**

```
feat(init): initialize fastify typescript project structure
feat(config): add environment config handling with dotenv
feat(logging): setup pino structured logging
feat(health): implement GET /health endpoint
feat(version): implement GET /version endpoint
feat(config-endpoint): implement GET /config endpoint
feat(validation): add input output validation schemas
chore(deps): install baseline fastify packages
test(health): add unit test for health endpoint
```

---

## 4. Code Style Rules (Enforced by ESLint + Prettier via Husky)

| Rule                  | Value                                  |
| --------------------- | -------------------------------------- |
| Language              | TypeScript (strict mode)               |
| Quotes                | Single quotes                          |
| Semicolons            | Required                               |
| Print width           | 100 characters                         |
| Tab width             | 2 spaces                               |
| Trailing commas       | Always                                 |
| Arrow function parens | Omit for single argument               |
| Return types          | Always declare explicitly              |
| `console.log`         | Not allowed — use `pino` logger        |
| Secrets in code       | Never — always via env/Secrets Manager |

---

## 5. Project Folder Structure (E1.1 Target)

Create exactly this structure. No deviations without architecture review.

```
wellapath-backend/
├── src/
│   ├── routes/          # Route registration files
│   ├── controllers/     # Request handlers (thin — delegate to services)
│   ├── services/        # Business logic
│   ├── plugins/         # Fastify plugins (db, cors, rate-limit, etc.)
│   ├── config/          # Environment config loading and validation
│   └── utils/           # Shared utility functions
├── tests/               # Unit and integration tests
├── .env.example         # Template — commit this, NOT .env
├── .env                 # Local secrets — NEVER commit
├── .gitignore
├── Dockerfile
├── package.json
├── tsconfig.json
├── eslint.config.js     # ESLint v9+ flat config (module.exports syntax)
└── .prettierrc
```

---

## 6. E1.1 — Backend Project Initialization

### Step-by-step tasks

**Step 1: Initialize the project**

```bash
npm init -y
```

**Step 2: Install TypeScript and core tooling**

```bash
npm install --save-dev typescript @types/node ts-node nodemon
npx tsc --init
```

`tsconfig.json` must include:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "rootDir": "./src",
    "outDir": "./dist",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 3: Install Fastify and baseline packages**

```bash
npm install fastify @fastify/cors @fastify/rate-limit pino pino-pretty dotenv pg
npm install --save-dev @types/pg
```

**Step 4: Install linting and formatting**

```bash
npm install --save-dev eslint @typescript-eslint/eslint-plugin @typescript-eslint/parser prettier eslint-config-prettier
```

**Step 5: Install Husky and Commitlint**

```bash
npm install --save-dev husky @commitlint/cli @commitlint/config-conventional lint-staged
npx husky init
```

**Step 6: Create `eslint.config.js`**

Use ESLint v9 flat config format. Use `module.exports` — NOT `export default` (causes module syntax error per onboarding doc):

```js
// eslint.config.js
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');

module.exports = [
  {
    files: ['src/**/*.ts'],
    languageOptions: { parser: tsParser },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'error',
    },
  },
];
```

**Step 7: Create `.prettierrc`**

```json
{
  "singleQuote": true,
  "semi": true,
  "printWidth": 100,
  "tabWidth": 2,
  "trailingComma": "all",
  "arrowParens": "avoid"
}
```

**Step 8: Add npm scripts to `package.json`**

```json
{
  "scripts": {
    "dev": "nodemon --exec ts-node src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js",
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "test": "jest"
  }
}
```

**Step 9: Create `.env.example`** (commit this file — it is the reference template)

```env
# Server
NODE_ENV=development
PORT=3000

# Database (get credentials from team lead or AWS Secrets Manager)
DB_HOST=wellapath-staging-db.cclsme0gujar.us-east-1.rds.amazonaws.com
DB_PORT=5432
DB_NAME=wellapath_staging
DB_USER=wellapath_admin
DB_PASSWORD=

# AWS
AWS_REGION=us-east-1

# Artifacts
ARTIFACT_BASE_URL=https://d179u2ex0g66o3.cloudfront.net

# App version
APP_VERSION=0.1.0
```

> Copy `.env.example` to `.env` and fill in `DB_PASSWORD` from team lead.
> Never commit `.env`.

**Step 10: Setup Pino structured logging in `src/utils/logger.ts`**

```ts
import pino from 'pino';

export const logger = pino({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  redact: ['req.headers.authorization'], // Never log auth headers
});
```

**Step 11: Create `src/config/env.ts`** — centralized config validation

```ts
import dotenv from 'dotenv';
dotenv.config();

interface AppConfig {
  nodeEnv: string;
  port: number;
  db: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
  };
  artifactBaseUrl: string;
  appVersion: string;
  awsRegion: string;
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

export const config: AppConfig = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  db: {
    host: requireEnv('DB_HOST'),
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    name: requireEnv('DB_NAME'),
    user: requireEnv('DB_USER'),
    password: requireEnv('DB_PASSWORD'),
  },
  artifactBaseUrl: requireEnv('ARTIFACT_BASE_URL'),
  appVersion: process.env.APP_VERSION ?? '0.1.0',
  awsRegion: process.env.AWS_REGION ?? 'us-east-1',
};
```

**Step 12: Create `src/server.ts`** — Fastify app entry point

```ts
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { config } from './config/env';
import { logger } from './utils/logger';
import { registerRoutes } from './routes';

const server = Fastify({
  logger,
});

const start = async (): Promise<void> => {
  await server.register(cors, { origin: true });
  await server.register(rateLimit, { max: 100, timeWindow: '1 minute' });

  registerRoutes(server);

  try {
    await server.listen({ port: config.port, host: '0.0.0.0' });
    server.log.info(`Server running on port ${config.port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
```

> `host: '0.0.0.0'` is required for ECS container networking.

---

## 7. E1.2 — Core Backend Endpoints

Three endpoints are required. Implement them exactly as specified.

### GET /health

**Purpose:** ECS health check + ALB target group health check.
**No auth required.**

Response shape:

```json
{
  "status": "ok",
  "timestamp": "2026-03-24T10:00:00.000Z"
}
```

File: `src/routes/health.ts`

```ts
import { FastifyInstance } from 'fastify';

export const healthRoutes = (server: FastifyInstance): void => {
  server.get('/health', async (_request, reply) => {
    return reply.status(200).send({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });
};
```

### GET /version

**Purpose:** Returns the current deployed application version.
**No auth required.**

Response shape:

```json
{
  "version": "0.1.0",
  "environment": "staging"
}
```

File: `src/routes/version.ts`

```ts
import { FastifyInstance } from 'fastify';
import { config } from '../config/env';

export const versionRoutes = (server: FastifyInstance): void => {
  server.get('/version', async (_request, reply) => {
    return reply.status(200).send({
      version: config.appVersion,
      environment: config.nodeEnv,
    });
  });
};
```

### GET /config

**Purpose:** Returns versioned artifact metadata so the mobile app knows what to download.
The mobile app boots by calling this endpoint first.

Response shape (locked contract — updated E2.5, confirmed by data engineer 2026-04-06):

```json
{
  "version": "1.0",
  "country": "ng",
  "artifacts": {
    "token_dictionary": {
      "version": "1.0",
      "url": "https://d179u2ex0g66o3.cloudfront.net/token_dictionary.ng.v1.0.json",
      "hash": "sha256:773006dee306a3b03312315134fe62d7abf1aa29baa1903a388854f34f24b76d",
      "release_date": "2026-04-06",
      "country": "ng"
    },
    "knowledge_base": {
      "version": "1.0",
      "url": "https://d179u2ex0g66o3.cloudfront.net/kb.ng.v1.0.json",
      "hash": "sha256:931049ed47200fa78d4bc44fcd9f4e544795a4901df6b16f7b491811b30d1699",
      "release_date": "2026-04-06",
      "country": "ng"
    },
    "rules": {
      "version": "1.0",
      "url": "https://d179u2ex0g66o3.cloudfront.net/rules.ng.v1.0.json",
      "hash": "sha256:1ae5f58308866b65fea137755454fc1a2aae07e1f7aff1ed730ad9dfb0941f8c",
      "release_date": "2026-04-06",
      "country": "ng"
    }
  }
}
```

> The mobile app must always consume URLs from this response — never construct CloudFront URLs directly.
> URLs are driven by `config.artifactBaseUrl` from env — never hardcoded.

File: `src/routes/config.ts`

```ts
import { FastifyInstance } from 'fastify';
import { config } from '../config/env';

export const configRoutes = (server: FastifyInstance): void => {
  server.get('/config', async (_request, reply) => {
    return reply.status(200).send({
      version: '1.0',
      country: 'ng',
      artifacts: {
        token_dictionary: {
          version: '1.0',
          url: `${config.artifactBaseUrl}/token_dictionary.ng.v1.0.json`,
          hash: 'sha256:773006dee306a3b03312315134fe62d7abf1aa29baa1903a388854f34f24b76d',
          release_date: '2026-04-06',
          country: 'ng',
        },
        knowledge_base: {
          version: '1.0',
          url: `${config.artifactBaseUrl}/kb.ng.v1.0.json`,
          hash: 'sha256:931049ed47200fa78d4bc44fcd9f4e544795a4901df6b16f7b491811b30d1699',
          release_date: '2026-04-06',
          country: 'ng',
        },
        rules: {
          version: '1.0',
          url: `${config.artifactBaseUrl}/rules.ng.v1.0.json`,
          hash: 'sha256:1ae5f58308866b65fea137755454fc1a2aae07e1f7aff1ed730ad9dfb0941f8c',
          release_date: '2026-04-06',
          country: 'ng',
        },
      },
    });
  });
};
```

### Route Registration

File: `src/routes/index.ts`

```ts
import { FastifyInstance } from 'fastify';
import { healthRoutes } from './health';
import { versionRoutes } from './version';
import { configRoutes } from './config';

export const registerRoutes = (server: FastifyInstance): void => {
  healthRoutes(server);
  versionRoutes(server);
  configRoutes(server);
};
```

---

## 8. Dockerfile (Required for ECS Deployment)

Create this at the project root:

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --only=production
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

---

## 9. .gitignore

Ensure these are in `.gitignore` before first commit:

```
node_modules/
dist/
build/
.env
*.env.local
*.log
.DS_Store
coverage/
```

---

## 10. PR Checklist Before Opening

Before opening any PR against `develop`:

- [ ] Branch synced with latest `develop`
- [ ] `npm run lint` passes with zero errors
- [ ] `npm run format:check` passes
- [ ] Server starts locally with `npm run dev` without errors
- [ ] All three endpoints return correct responses locally
- [ ] No `.env` file staged
- [ ] No `node_modules` or `dist/` staged
- [ ] No secrets or credentials in any committed file
- [ ] Commit messages follow Conventional Commits format
- [ ] PR title follows format: `feat(e1): implement backend init and core endpoints`
- [ ] PR description fills in all template sections

---

## 11. E1 Exit Criteria (Must Pass Before E2 Starts)

Per the Engineering Workflow Backlog:

- [ ] Backend deployed to staging (ECS) with `/health`, `/version`, `/config` responding
- [ ] Mobile app can fetch `/config` from `https://api-staging.wellapath.org/config`
- [ ] Mobile app caches returned config and artifact metadata
- [ ] HTTPS works on staging (`api-staging.wellapath.org`)
- [ ] Staging environment is stable

---

## 12. Common Errors & Fixes (Windows / Git Bash)

| Error                                          | Cause                                       | Fix                                                                        |
| ---------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------- |
| `husky - commit-msg script failed`             | Bad commit message format                   | Fix message — see Section 3                                                |
| `husky - pre-commit script failed`             | ESLint or Prettier failed                   | Run `npm run lint:fix && npm run format`                                   |
| `Cannot use import statement outside a module` | Wrong ESLint config syntax                  | Use `module.exports = []` not `export default []` in `eslint.config.js`    |
| `ESLint couldn't find an eslint.config file`   | Old `.eslintrc.json` format with ESLint v9+ | Replace with `eslint.config.js` using `module.exports` syntax              |
| `git push` hangs or fails                      | Windows credential issue                    | Use Git Bash (not PowerShell). Check Windows Credential Manager            |
| `node_modules` shows in `git status`           | Missing `.gitignore`                        | Add `node_modules/` to `.gitignore`, run `git rm -r --cached node_modules` |
| `fatal: unable to auto-detect email`           | Git identity not set                        | Run `git config --global user.email "you@email.com"` and `user.name`       |

> **Windows rule:** Always use Git Bash for all git commands. Never use PowerShell or CMD.

---

## 13. What NOT to Build in E1

Do not build or add any of the following — they belong to later phases:

| What                                        | Phase      |
| ------------------------------------------- | ---------- |
| Symptom input, scoring logic, triage engine | E3         |
| Condition knowledge base or rules JSON      | E2         |
| User accounts, auth, sessions               | Not in MVP |
| Facility locator                            | E6         |
| Full KB expansion                           | E7         |
| Any PHI storage of any kind                 | Never      |
| Server-side scoring                         | Never      |
