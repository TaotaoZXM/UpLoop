# Public snapshot notes

This directory is the first clean public source snapshot of UpLoop, prepared 2026-11-23 (Asia/Shanghai). It is a sanitized file tree, not a copy of any private repository's git history.

Included: UpLoop product source (`server/`, `web/`), tests, `package.json`, `package-lock.json`, `tsconfig.json`, sanitized `deploy/.env.example`, and short run/self-host docs.

Excluded from this snapshot (among other non-product local files): real `.env`, `legacy/` (including qingzhou and fitness-helper), databases, firmware, brand artwork, browser captures, agent memory, icon backups, historical production nginx/cloud-server unit files, and git history.

Internal compatibility identifiers such as `BASE_PATH=/task`, cookie `task_session`, and service-worker prefix `task-` are kept on purpose.

A license file is not included because none was authorized for this publication.

The root README is the user-facing introduction. It was proofread against this tree on 2026-11-23: the dock item labeled Home opens `startScreen`, while the day board lives in `web/js/home.js` as `homeScreen` and is not described as a verified default-navigation entry. Task Pull in `web/js/draw.js` draws up to three open-task cards. Gender, water goal, and birth month appear only when `WELLNESS_ENABLED=1`; with that flag off, first-run onboarding asks only for cloud-processing consent.

Automated check recorded before publication commit `dc57255a88190bd0e62f72f159dc3afd84bf1cc3`, at 2026-11-23 01:40 Asia/Shanghai (2026-11-22 17:40 UTC): `npm ci` reported 0 vulnerabilities, `npm run typecheck` passed, and `npm test` passed 221 tests in 55 suites with 0 failures. That check did not include a browser click-through, and this README update does not add one.

Do not read this sanitized tree as a byte-for-byte copy of a local working directory. The omitted environment files, databases, and historical deployment material are intentional. A demo process started earlier is not evidence that it loaded every file changed on disk after it started.
