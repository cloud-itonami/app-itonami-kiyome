/**
 * kiyome (清め, purification) — compliance clearing, local domain (AWAI-3079).
 *
 * Designed from the former Worker's method list and bpmn/kiyome-control.bpmn
 * (submitClearance / listClearances / approveClearance / rejectClearance /
 * createAuditLog / listAuditLogs / getComplianceStatus / runPurification);
 * the original logic ran on a remote LangServer and was not in this repository.
 *
 *   clearance  : a request to clear a subject for a category. pending →
 *                approved | rejected (by a reviewer other than the requester)
 *                or → expired by purification. Decided clearances are final.
 *   audit log  : every transition writes an entry automatically; manual entries
 *                can be added. Entries are never changed.
 *   status     : counts per state, approval rate, oldest pending age.
 *   purify     : expires pending clearances older than N days.
 */
import type { LocalStore } from "../local-store.js";
import { getOne, idSlug, isNonEmpty, listAll, nowISO, put } from "./records.js";

export const CLEARANCE = "cloud.itonami.apps.kiyome.clearance";
export const AUDIT = "cloud.itonami.apps.kiyome.auditLog";
export const CATEGORIES = ["data", "finance", "content", "access", "other"] as const;
export type Category = (typeof CATEGORIES)[number];
export type ClearanceStatus = "pending" | "approved" | "rejected" | "expired";

export interface Clearance {
  clearanceId: string; subject: string; category: Category; detail: string; requester: string;
  status: ClearanceStatus; submittedAt: string; decidedAt?: string; reviewer?: string; note?: string;
}

export interface SubmitClearanceInput { clearanceId: string; subject: string; category: Category; requester: string; detail?: string }
export interface ListClearancesInput { status?: ClearanceStatus }
export interface ApproveClearanceInput { clearanceId: string; reviewer: string; note?: string }
export interface RejectClearanceInput { clearanceId: string; reviewer: string; reason: string }
export interface CreateAuditLogInput { logId?: string; action: string; actor: string; target?: string; detail?: string }
export interface ListAuditLogsInput { target?: string; actor?: string }
export interface GetComplianceStatusInput {}
export interface RunPurificationInput { olderThanDays: number; actor: string }

const cKey = (id: string) => `clearance-${idSlug(id)}`;
let seq = 0;

async function audit(e: LocalStore, entry: { action: string; actor: string; target?: string; detail?: string }, logId?: string) {
  const at = nowISO();
  const id = logId || `${at}-${(seq++ % 1e6).toString().padStart(6, "0")}`;
  await put(e, AUDIT, `log-${idSlug(id)}`, { logId: id, ...entry, at });
  return id;
}

export async function submitClearance(e: LocalStore, input: SubmitClearanceInput) {
  if (![input.clearanceId, input.subject, input.requester].every(isNonEmpty)) return { status: "rejected", error: "missingRequiredFields" };
  if (!CATEGORIES.includes(input.category)) return { status: "rejected", error: "unknownCategory" };
  if (await getOne(e, CLEARANCE, cKey(input.clearanceId))) return { status: "alreadyExists" };
  const c: Clearance = { clearanceId: input.clearanceId, subject: input.subject, category: input.category, detail: input.detail ?? "", requester: input.requester, status: "pending", submittedAt: nowISO() };
  await put(e, CLEARANCE, cKey(input.clearanceId), c);
  await audit(e, { action: "submit", actor: input.requester, target: input.clearanceId });
  return { status: "submitted", clearanceId: input.clearanceId };
}

export async function listClearances(e: LocalStore, input: ListClearancesInput = {}) {
  const all = (await listAll<Clearance>(e, CLEARANCE)).map((r) => r.value).filter((c) => !input.status || c.status === input.status);
  return { items: all.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt)), total: all.length };
}

async function decide(e: LocalStore, id: string, reviewer: string, to: "approved" | "rejected", note: string | undefined) {
  if (!isNonEmpty(id) || !isNonEmpty(reviewer)) return { status: "rejected", error: "missingRequiredFields" };
  const c = await getOne<Clearance>(e, CLEARANCE, cKey(id));
  if (!c) return { status: "rejected", error: "clearanceNotFound" };
  if (c.value.status !== "pending") return { status: "rejected", error: "notPending", current: c.value.status };
  if (c.value.requester === reviewer) return { status: "rejected", error: "reviewerIsRequester" };
  await put(e, CLEARANCE, cKey(id), { ...c.value, status: to, reviewer, note, decidedAt: nowISO() });
  await audit(e, { action: to === "approved" ? "approve" : "reject", actor: reviewer, target: id, detail: note });
  return { status: to, clearanceId: id };
}

export async function approveClearance(e: LocalStore, input: ApproveClearanceInput) {
  return decide(e, input.clearanceId, input.reviewer, "approved", input.note);
}

export async function rejectClearance(e: LocalStore, input: RejectClearanceInput) {
  if (!isNonEmpty(input.reason)) return { status: "rejected", error: "reasonRequired" };
  return decide(e, input.clearanceId, input.reviewer, "rejected", input.reason);
}

export async function createAuditLog(e: LocalStore, input: CreateAuditLogInput) {
  if (!isNonEmpty(input.action) || !isNonEmpty(input.actor)) return { status: "rejected", error: "missingRequiredFields" };
  if (input.logId && (await getOne(e, AUDIT, `log-${idSlug(input.logId)}`))) return { status: "rejected", error: "logIdExists" };
  const logId = await audit(e, { action: input.action, actor: input.actor, target: input.target, detail: input.detail }, input.logId);
  return { status: "logged", logId };
}

export async function listAuditLogs(e: LocalStore, input: ListAuditLogsInput = {}) {
  const all = (await listAll<{ logId: string; action: string; actor: string; target?: string; at: string }>(e, AUDIT)).map((r) => r.value)
    .filter((l) => (!input.target || l.target === input.target) && (!input.actor || l.actor === input.actor));
  return { items: all.sort((a, b) => a.at.localeCompare(b.at)), total: all.length };
}

export async function getComplianceStatus(e: LocalStore, input: GetComplianceStatusInput = {}, now: Date = new Date()) {
  const all = (await listClearances(e)).items;
  const counts: Record<ClearanceStatus, number> = { pending: 0, approved: 0, rejected: 0, expired: 0 };
  for (const c of all) counts[c.status]++;
  const decided = counts.approved + counts.rejected;
  const oldest = all.filter((c) => c.status === "pending").map((c) => Date.parse(c.submittedAt)).sort((a, b) => a - b)[0];
  return {
    counts, total: all.length,
    approvalRate: decided ? Math.round((counts.approved / decided) * 1000) / 1000 : null,
    oldestPendingDays: oldest === undefined ? null : Math.floor((now.getTime() - oldest) / 86_400_000),
  };
}

export async function runPurification(e: LocalStore, input: RunPurificationInput, now: Date = new Date()) {
  if (typeof input.olderThanDays !== "number" || input.olderThanDays < 0) return { status: "rejected", error: "olderThanDaysMustBeNonNegative" };
  if (!isNonEmpty(input.actor)) return { status: "rejected", error: "missingRequiredFields" };
  const cutoff = now.getTime() - input.olderThanDays * 86_400_000;
  const expired: string[] = [];
  for (const c of (await listClearances(e, { status: "pending" })).items) {
    if (Date.parse(c.submittedAt) <= cutoff) {
      await put(e, CLEARANCE, cKey(c.clearanceId), { ...c, status: "expired", decidedAt: now.toISOString(), reviewer: input.actor, note: `purified: pending > ${input.olderThanDays}d` });
      await audit(e, { action: "expire", actor: input.actor, target: c.clearanceId });
      expired.push(c.clearanceId);
    }
  }
  return { status: "purified", expired, count: expired.length };
}
