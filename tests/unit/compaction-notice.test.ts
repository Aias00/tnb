import { expect, test } from "bun:test";
import { CompactionNotices, compactionInfo } from "../../src/services/compact/notice";
test("light cleanup never floods the transcript; summaries and collapse have distinct truthful notices", () => {
  const notices = new CompactionNotices();
  for (let i = 0; i < 10; i++) expect(notices.message(5000 - i, 4000 - i, { strategy: "microcompact" })).toBeUndefined();
  expect(notices.message(12000, 2000, { strategy: "full" })).toContain("已生成上下文摘要");
  expect(notices.message(12000, 2000, { strategy: "full" })).toBeUndefined();
  expect(notices.message(12000, 2000, { strategy: "context-collapse" })).toContain("较早对话已折叠");
  expect(notices.message(1000, 800)).toContain("类型未记录");
  expect(compactionInfo({ strategy: "invented" }).strategy).toBe("unknown");
});
