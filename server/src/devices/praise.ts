/** Reuses the web app's praise corpus (apps/boat/web/js/praise-corpus.js) and picker (praise.js)
 *  so the device says the same encouraging lines as the browser. Loaded once in a sandbox. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "web");

type Praise = { compose: (ev: Record<string, unknown>, rnd?: () => number, hist?: string[]) => string };

let praise: Praise | null = null;
const history: string[] = [];

function load(): Praise {
  const window: Record<string, unknown> = {};
  const ctx = vm.createContext({
    window,
    document: { readyState: "complete", addEventListener() {}, querySelectorAll: () => [] },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: () => 0, clearTimeout() {},
    requestAnimationFrame: () => 0,
  });
  ctx.SpeechSynthesisUtterance = function () {};
  window.speechSynthesis = undefined;
  vm.runInContext(readFileSync(join(webDir, "js/praise-corpus.js"), "utf8"), ctx);
  vm.runInContext(readFileSync(join(webDir, "js/praise.js"), "utf8"), ctx);
  return (window.Task as { praise: Praise }).praise;
}

export function praiseLine(ev: Record<string, unknown>): string {
  try {
    if (!praise) praise = load();
    return praise.compose(ev, Math.random, history);
  } catch {
    return "";
  }
}
