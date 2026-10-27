import { afterEach, beforeEach, expect, test, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../../helpers/remove-tree";
import { getAccountSet, removeAccount, saveCredential, saveAccountCredential, markAccountNeedsReauth } from "../../../src/oauth/store";
import { AnthropicSessionAffinityStore, anthropicAffinityDigest, anthropicAffinityPath,
  AFFINITY_IDLE_TTL_MS, MAX_AFFINITY_FILE_BYTES } from "../../../src/oauth/anthropic-session-affinity-store";
import { atomicWriteFile } from "../../../src/config/atomic-write";
import { runOptionalShutdownHooks } from "../../../src/lib/optional-shutdown-hooks";
import { settleBackgroundWork } from "../../../src/lib/background-work";

const originalHome = process.env.OPENCODEX_HOME;
let home: string;
let id: string;
let stores: AnthropicSessionAffinityStore[];
const secret = "never-store-this-session-or-bearer";
const key = anthropicAffinityDigest("anthropic", secret);
const path = () => anthropicAffinityPath(home, "anthropic");
const credential = () => ({ access: "fixture-only-bearer", refresh: "fixture-only-refresh", expires: Date.now() + 3_600_000, accountId: "fixture-account" });
function owner(instance: "anthropic" | "anthropic-team" = "anthropic", write?: typeof atomicWriteFile) {
  const store = new AnthropicSessionAffinityStore(instance, write); stores.push(store); return store;
}
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ocx-affinity-store-")); process.env.OPENCODEX_HOME = home; stores = [];
  await saveCredential("anthropic", credential()); id = getAccountSet("anthropic")!.accounts[0]!.id;
});
afterEach(async () => {
  for (const store of stores) { await store.flush(); store.resetMemory(); }
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});
async function snapshot() {
  const store = owner(); store.set(key, { accountId: id, lastUsedAt: Date.now() }); await store.flush();
  return { store, data: JSON.parse(readFileSync(path(), "utf8")) };
}
test("snapshot contains only digests, opaque account and timestamp", async () => {
  const { store } = await snapshot(); const bytes = readFileSync(path(), "utf8");
  for (const value of [secret, "fixture-only-bearer", "fixture-only-refresh", "fixture-account"]) expect(bytes).not.toContain(value);
  const row = JSON.parse(bytes).entries[0];
  expect(Object.keys(row).sort()).toEqual(["accountId", "lastUsedAt", "loginFence", "sessionDigest"]);
  expect(row.sessionDigest).toBe(key); expect(row.loginFence).toMatch(/^[a-f0-9]{64}$/);
  store.resetMemory(); expect(store.get(key)?.accountId).toBe(id);
});
test("back-to-back structural mutations are both persisted and raw keys are refused", async () => {
  const store = owner(); const other = anthropicAffinityDigest("anthropic", "second");
  store.set(key, { accountId: id, lastUsedAt: Date.now() });
  store.set(other, { accountId: id, lastUsedAt: Date.now() });
  store.set(secret, { accountId: id, lastUsedAt: Date.now() });
  await store.flush(); store.resetMemory();
  expect(store.size).toBe(2); expect(store.get(other)?.accountId).toBe(id);
  expect(readFileSync(path(), "utf8")).not.toContain(secret);
});
test("load rejects expired and future rows and keeps the newest 2000", async () => {
  const { store, data } = await snapshot(); const now = Date.now(); const base = data.entries[0];
  data.entries = Array.from({ length: 2002 }, (_, i) => ({ ...base,
    sessionDigest: i.toString(16).padStart(64, "0"), lastUsedAt: now - i }));
  data.entries.push({ ...base, sessionDigest: "a".repeat(64), lastUsedAt: now - AFFINITY_IDLE_TTL_MS - 1 },
    { ...base, sessionDigest: "b".repeat(64), lastUsedAt: now + 60_000 });
  writeFileSync(path(), JSON.stringify(data)); store.resetMemory();
  expect(store.size).toBe(2000); expect(store.get((2001).toString(16).padStart(64, "0"))).toBeUndefined();
  expect(store.get("a".repeat(64))).toBeUndefined(); expect(store.get("b".repeat(64))).toBeUndefined();
});
test.each(["{bad json", JSON.stringify({ version: 2, entries: [] }), JSON.stringify({ version: 1, entries: [{}] }), " ".repeat(MAX_AFFINITY_FILE_BYTES + 1)])("invalid or oversized snapshot is ignored (%#)", bytes => {
  writeFileSync(path(), bytes); expect(owner().size).toBe(0);
});
test("provider instance and config home are isolated", async () => {
  const { store } = await snapshot();
  expect(owner("anthropic-team").get(key)).toBeUndefined();
  const other = mkdtempSync(join(tmpdir(), "ocx-affinity-other-"));
  try { process.env.OPENCODEX_HOME = other; expect(store.get(key)).toBeUndefined(); }
  finally { store.resetMemory(); process.env.OPENCODEX_HOME = home; removeTreeWithRetry(other); }
  expect(store.get(key)?.accountId).toBe(id);
});
test("token refresh keeps the fence while replacement login invalidates", async () => {
  const { store } = await snapshot();
  await saveAccountCredential("anthropic", id, { ...credential(), access: "fixture-refreshed-token" });
  store.resetMemory(); expect(store.get(key)?.accountId).toBe(id);
  await saveCredential("anthropic", credential());
  store.resetMemory(); expect(store.get(key)).toBeUndefined();
});
test("removal and re-add cannot resurrect the old snapshot", async () => {
  const { store } = await snapshot(); const old = readFileSync(path(), "utf8");
  await removeAccount("anthropic", id); await saveCredential("anthropic", credential());
  writeFileSync(path(), old); store.resetMemory(); expect(store.get(key)).toBeUndefined();
});
test("reauthentication invalidation is persisted before the flag clears", async () => {
  const { store } = await snapshot();
  await markAccountNeedsReauth("anthropic", id, true);
  store.resetMemory(); expect(store.get(key)).toBeUndefined(); await store.flush();
  await markAccountNeedsReauth("anthropic", id, false);
  store.resetMemory(); expect(store.get(key)).toBeUndefined();
  expect(JSON.parse(readFileSync(path(), "utf8")).entries).toEqual([]);
});
test("failed atomic publication retains previous bytes and reports no identifiers", async () => {
  await snapshot(); const before = readFileSync(path(), "utf8");
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const store = owner("anthropic", (p, content) => atomicWriteFile(p, content, undefined, {
      beforeRename: () => { throw new Error("fixture publication failure"); },
    }));
    store.set(anthropicAffinityDigest("anthropic", "second"), { accountId: id, lastUsedAt: Date.now() });
    await store.flush(); expect(readFileSync(path(), "utf8")).toBe(before);
    expect(warning).toHaveBeenCalled(); expect(JSON.stringify(warning.mock.calls)).not.toContain(secret);
    store.resetMemory();
  } finally { warning.mockRestore(); }
});
test("timestamp touches coalesce and shutdown flushes the latest use", async () => {
  let writes = 0; const store = owner("anthropic", (...args) => { writes++; atomicWriteFile(...args); });
  const now = Date.now(); store.set(key, { accountId: id, lastUsedAt: now - 100 }); await store.flush();
  store.set(key, { accountId: id, lastUsedAt: now - 50 }); store.set(key, { accountId: id, lastUsedAt: now });
  expect(writes).toBe(1); runOptionalShutdownHooks();
  expect((await settleBackgroundWork({ timeoutMs: 5_000 })).settled).toBe(true);
  expect(writes).toBe(2);
  expect(JSON.parse(readFileSync(path(), "utf8")).entries[0].lastUsedAt).toBe(now);
});
