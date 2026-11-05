import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactConversation, createTransportSummarizer } from "../../src/services/compact/compact";
import { assertBalancedToolHistory } from "../../src/core/history";
import { SessionMemoryStore } from "../../src/services/compact/session-memory";
import type { ConversationMessage } from "../../src/core/message";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const history: ConversationMessage[] = [
 {role:"user",content:[{type:"text",text:"task".repeat(500)}]},
 {role:"assistant",content:[{type:"tool-use",id:"a",name:"read",input:{}}]},
 {role:"user",content:[{type:"tool-result",toolUseId:"a",content:"code",isError:false}]},
 {role:"assistant",content:[{type:"tool-use",id:"b",name:"read",input:{}}]},
 {role:"user",content:[{type:"tool-result",toolUseId:"b",content:"code",isError:false}]},
];
test("full compaction never retains an orphaned tool result",async()=>{
 const result=await compactConversation({messages:history,thresholdTokens:1,summarize:async()=>"summary"});
 expect(()=>assertBalancedToolHistory(result.messages)).not.toThrow();
 expect(result.postTokens).toBeLessThan(result.preTokens);
});
test("a replacement larger than its input is rejected",async()=>{
 await expect(compactConversation({messages:history,thresholdTokens:1,summarize:async()=>"x".repeat(20000)})).rejects.toThrow("smaller");
});
test("a nonempty summary still needs a successful terminal response",async()=>{
 const summarize=createTransportSummarizer({model:"fixture",transport:{async *stream(){yield{type:"text",index:0,text:"partial"};yield{type:"response-end",reason:"max-tokens"};}}});
 await expect(summarize(history)).rejects.toThrow("complete successfully");
});
test("a newer smaller context wins and late background candidates cannot replace it",async()=>{
 const root=await mkdtemp(join(tmpdir(),"tnb-memory-revision-"));roots.push(root);
 const memory=new SessionMemoryStore(join(root,"memory.json"));await memory.initialize();
 await memory.save("old large context",history,100000,10);
 await memory.save("new compact context",history,1000,11);
 await memory.save("late old context",history,100000,10);
 expect(memory.current()?.summary).toBe("new compact context");
 expect(memory.current()?.sourceRevision).toBe(11);
});
