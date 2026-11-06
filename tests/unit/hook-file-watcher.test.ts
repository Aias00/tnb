import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { watch } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HookFileWatcher } from "../../src/services/hooks/file-watcher";
let nativeCallback: ((event: string, filename: string) => void) | undefined;
const silentWatch = ((_directory: unknown, _options: unknown, listener: unknown) => { nativeCallback = listener as typeof nativeCallback; return { on() { return this; }, close() {} }; }) as unknown as typeof watch;
async function until(check: () => boolean) { const deadline=Date.now()+2000; while(!check()) { if(Date.now()>deadline) throw new Error("Watcher result timed out"); await Bun.sleep(10); } }
test("explicit file matchers recover from lost native notifications without duplicate hooks and stop on close", async () => {
  const root = await mkdtemp(join(tmpdir(),"tnb-hook-poll-")), target = join(root,"watched.txt"), events: string[] = [];
  const watcher = new HookFileWatcher({ cwd: root, matchers: ["watched.txt"], watch: silentWatch, pollIntervalMs: 20, onChange: async (_path,event) => { events.push(event); } });
  try {
    await watcher.start(); await writeFile(target,"first"); await until(()=>events.length===1); expect(events).toEqual(["add"]);
    await Bun.sleep(250); expect(events).toHaveLength(1);
    await writeFile(target,"second"); await until(()=>events.length===2); expect(events[1]).toBe("change");
    await rm(target); await until(()=>events.length===3); expect(events[2]).toBe("unlink");
    watcher.close(); await writeFile(target,"after close"); nativeCallback?.("rename", "watched.txt"); await Bun.sleep(250); expect(events).toHaveLength(3);
  } finally { watcher.close(); await rm(root,{recursive:true,force:true}); }
});
