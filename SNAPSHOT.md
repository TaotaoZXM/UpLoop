# Public snapshot notes

This directory is the first clean public source snapshot of UpLoop, prepared 2026-11-23 (Asia/Shanghai). It is a sanitized file tree, not a copy of any private repository's git history.

Included: UpLoop product source (`server/`, `web/`), tests, `package.json`, `package-lock.json`, `tsconfig.json`, sanitized `deploy/.env.example`, and short run/self-host docs.

Excluded from this snapshot (among other non-product local files): real `.env`, `legacy/` (including qingzhou and fitness-helper), databases, firmware, brand artwork, browser captures, agent memory, icon backups, historical production nginx/cloud-server unit files, and git history.

Internal compatibility identifiers such as `BASE_PATH=/task`, cookie `task_session`, and service-worker prefix `task-` are kept on purpose.

A license file is not included because none was authorized for this publication.
