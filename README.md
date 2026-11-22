# UpLoop

This repository is the first clean public source snapshot of **UpLoop**, prepared on 2026-11-23 (Asia/Shanghai). It contains a sanitized copy of the latest product source, tests, and lockfile. It is **not** a publication of any previous private repository's git history, and it is **not** a website deployment.

UpLoop is a personal productivity web app: a PWA frontend plus an Express / TypeScript API. A full server run uses PostgreSQL. The product name shown in the UI is UpLoop.

Some **internal compatibility identifiers are intentional and should not be renamed blindly**:

- URL mount prefix `/task` (`BASE_PATH`, default in the local demo)
- Session cookie name `task_session`
- Service worker cache prefix `task-` (current cache bucket in this snapshot: `task-v57`)

## Requirements

- Node.js 22 or newer (`package.json` `engines`)
- PostgreSQL, only for `npm start` / `npm run migrate`
- No PostgreSQL is required for `npm run demo` or the unit test suite

## Setup

```bash
npm ci
cp deploy/.env.example .env
```

Edit `.env` and replace every placeholder. Never commit `.env`.

## Local demo (in-memory, no PostgreSQL)

```bash
npm run demo
```

This starts the full API with a seeded in-memory dataset. Data lives only in that process and resets when it exits.

- App: http://127.0.0.1:8896/task/
- One-click demo login: http://127.0.0.1:8896/task/demo
- Demo account: `admin` / `12345678`

The demo script sets `PORT=8896` and `BASE_PATH=/task` unless you override them. It does not set a DeepSeek key; without `DEEPSEEK_API_KEY`, chat uses rule-based replies.

## Full server (PostgreSQL)

`.env` must include a real local `DATABASE_URL` and a `JWT_SECRET` of at least 16 characters (see `server/src/env.ts`). `DEVICE_TOKEN_SECRET` is required when `NODE_ENV=production`.

```bash
npm run migrate
npm start
```

Defaults: `HOST=127.0.0.1`, `PORT=3200`. With `BASE_PATH=/task`, open http://127.0.0.1:3200/task/. Use `npm run dev` for `tsx watch`. Migrations default to cap `001`; `002` needs the PostgreSQL `ltree` extension.

Optional model keys (`DEEPSEEK_API_KEY`, `DASHSCOPE_API_KEY`) stay empty unless you configure those providers yourself. Official default model names and public API bases are listed in `deploy/.env.example` and `server/src/env.ts`.

## Tests

```bash
npm run typecheck
DEEPSEEK_API_KEY= DASHSCOPE_API_KEY= DATABASE_URL= BASE_PATH= npm test
```

Do not point tests at a real database or real API keys, and do not load a personal `.env`.

## What is in this snapshot

- `server/` — TypeScript API, database migrations, and tests
- `web/` — frontend (HTML/CSS/JS, icons, service worker, manifest)
- `package.json` and `package-lock.json`
- `deploy/.env.example` and a short self-host outline (placeholders only)

Historical production host names, nginx/cloud-server configs, firmware, design source artwork, local environment files, databases, browser captures, and other apps are not included.

This snapshot does not add a license file; none was authorized for this publication.

## Self-hosting and GitHub Pages

See `deploy/README.md`. GitHub Pages cannot run the TypeScript/Express API or PostgreSQL, so it cannot host the working app. This snapshot is source only.
