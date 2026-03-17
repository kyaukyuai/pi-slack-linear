import { describe, expect, it } from "vitest";
import { buildThreadPaths } from "../src/lib/thread-workspace.js";

describe("thread workspace", () => {
  it("builds fixed paths for a thread", () => {
    const paths = buildThreadPaths("/workspace", "C123", "1742198400.123456");

    expect(paths.rootDir).toBe("/workspace/threads/C123/1742198400_123456");
    expect(paths.sessionFile).toBe("/workspace/threads/C123/1742198400_123456/session.jsonl");
    expect(paths.logFile).toBe("/workspace/threads/C123/1742198400_123456/log.jsonl");
    expect(paths.attachmentsDir).toBe("/workspace/threads/C123/1742198400_123456/attachments");
    expect(paths.scratchDir).toBe("/workspace/threads/C123/1742198400_123456/scratch");
  });
});
