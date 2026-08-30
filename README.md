# WellaPath Backend

Backend API service for WellaPath — a clinical decision support system (CDSS) for frontline health workers in Nigeria.

WellaPath is deliberately thin on the server side: the mobile app is offline-first and runs the full decision engine on the device against versioned clinical JSON artifacts (see [wellapath-knowledge-base](https://github.com/Wellapath-org/wellapath-knowledge-base) and [wellapath-mobile](https://github.com/Wellapath-org/wellapath-mobile)). This service's role is to provide the lightweight server-side pieces the app depends on — starting with the configuration endpoint the mobile boot sequence fetches (and gracefully falls back from when offline).

## Status

This repository is an early scaffold — it currently contains environment configuration only. The service code has not landed yet; this README describes the planned setup honestly rather than a finished product.

## Planned stack

- **Fastify** on Node.js with **TypeScript**
- **PostgreSQL** (via `DATABASE_URL`)
- **AWS S3** for clinical artifact storage/distribution (`AWS_REGION`, `S3_ARTIFACT_BUCKET`)

## Configuration

Copy the example environment file and fill in real values:

```bash
cp .env.example .env
```

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | Runtime environment (`development`, ...) |
| `PORT` / `HOST` | Server bind address (defaults `3000` / `0.0.0.0`) |
| `DATABASE_URL` | PostgreSQL connection string |
| `LOG_LEVEL` | Logger verbosity |
| `AWS_REGION` / `S3_ARTIFACT_BUCKET` | S3 bucket for versioned clinical artifacts |
| `APP_VERSION` | Reported application version |

## Related repositories

- [wellapath-mobile](https://github.com/Wellapath-org/wellapath-mobile) — offline-first Flutter app with the on-device CDSS engine
- [wellapath-knowledge-base](https://github.com/Wellapath-org/wellapath-knowledge-base) — versioned clinical JSON artifacts (knowledge base, rules, token dictionary, facilities)
