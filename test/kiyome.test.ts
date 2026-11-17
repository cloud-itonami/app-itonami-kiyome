import { describe, it, beforeEach } from "node:test";
import { expect } from "./expect.mjs";
import { LocalStore } from "../dist/local-store.js";
import { submitClearance, listClearances, approveClearance, rejectClearance, createAuditLog, listAuditLogs, getComplianceStatus, runPurification } from "../dist/domain/index.js";

describe("kiyome clearing", () => {
  let e: any;
  beforeEach(async () => {
    e = new LocalStore({ did: "did:web:kiyome.itonami.cloud" });
    await submitClearance(e, { clearanceId: "c1", subject: "dataset A", category: "data", requester: "alice" });
    await submitClearance(e, { clearanceId: "c2", subject: "invoice 7", category: "finance", requester: "bob" });
  });

  it("validates submissions", async () => {
    expect((await submitClearance(e, { clearanceId: "c1", subject: "x", category: "data", requester: "a" })).status).toBe("alreadyExists");
    expect((await submitClearance(e, { clearanceId: "c3", subject: "x", category: "weird" as any, requester: "a" })).error).toBe("unknownCategory");
    expect((await listClearances(e, { status: "pending" })).total).toBe(2);
  });

  it("decides once, needs a different reviewer and a rejection reason", async () => {
    expect((await approveClearance(e, { clearanceId: "c1", reviewer: "alice" })).error).toBe("reviewerIsRequester");
    expect((await approveClearance(e, { clearanceId: "c1", reviewer: "carol" })).status).toBe("approved");
    expect((await rejectClearance(e, { clearanceId: "c1", reviewer: "dave", reason: "late" })).error).toBe("notPending");
    expect((await rejectClearance(e, { clearanceId: "c2", reviewer: "carol", reason: "" })).error).toBe("reasonRequired");
    expect((await rejectClearance(e, { clearanceId: "c2", reviewer: "carol", reason: "missing receipt" })).status).toBe("rejected");
    expect((await approveClearance(e, { clearanceId: "zz", reviewer: "carol" })).error).toBe("clearanceNotFound");
  });

  it("writes an audit entry for every transition, plus manual entries", async () => {
    await approveClearance(e, { clearanceId: "c1", reviewer: "carol" });
    expect((await listAuditLogs(e, { target: "c1" })).items.map((l: any) => l.action).join(",")).toBe("submit,approve");
    expect((await createAuditLog(e, { logId: "m1", action: "note", actor: "carol", detail: "spot check" })).status).toBe("logged");
    expect((await createAuditLog(e, { logId: "m1", action: "note", actor: "carol" })).error).toBe("logIdExists");
    expect((await listAuditLogs(e, { actor: "carol" })).total).toBe(2);
  });

  it("summarizes status and purifies stale pending clearances", async () => {
    await approveClearance(e, { clearanceId: "c1", reviewer: "carol" });
    const later = new Date(Date.now() + 10 * 86_400_000);
    const s = await getComplianceStatus(e, {}, later);
    expect(s.counts.pending).toBe(1);
    expect(s.approvalRate).toBe(1);
    expect(s.oldestPendingDays).toBe(10);
    expect((await runPurification(e, { olderThanDays: 30, actor: "sys" }, later)).count).toBe(0);
    const p = await runPurification(e, { olderThanDays: 7, actor: "sys" }, later);
    expect(p.expired.join(",")).toBe("c2");
    expect((await getComplianceStatus(e, {}, later)).counts.expired).toBe(1);
    expect((await listAuditLogs(e, { target: "c2" })).items.map((l: any) => l.action).join(",")).toBe("submit,expire");
  });
});
