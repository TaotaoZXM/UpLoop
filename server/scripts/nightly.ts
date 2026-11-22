/**
 * systemd timer entry point. Install as:
 *   task-nightly.timer -> OnCalendar=*-*-* 02:30:00 Asia/Shanghai
 *   task-nightly.service -> ExecStart=/usr/bin/node --import tsx server/scripts/nightly.ts
 * No in-process timers (§8 WP2.8 / §9 WP3.2).
 */
import { createDb } from "../src/db/pool.js";
import { detectMemoryTables } from "../src/memory/projection.js";
import { nightlyRun } from "../src/memory/summary.js";

const db = createDb();
try {
  const enabled = await detectMemoryTables(db);
  if (!enabled) {
    console.log("[task] memory layer not installed (run 002_memory.sql / MIGRATE_MAX=002); nothing to do");
  } else {
    const report = await nightlyRun(db);
    console.log(`[task] nightly: rebuilt=${report.rebuilt} created=${report.created}`);
  }
} finally {
  await db.end();
}
