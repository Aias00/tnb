import { describe, expect, test } from "bun:test";

import { formatResumeHint } from "../../src/ui/app";

describe("TUI resume hint", () => {
  test("prints a directly runnable command for the active session", () => {
    expect(formatResumeHint("943b3af1-cb4c-4a7b-b996-f48c39a45f60")).toBe(
      "\nResume this session with:\ntnb --resume 943b3af1-cb4c-4a7b-b996-f48c39a45f60\n",
    );
  });
});
