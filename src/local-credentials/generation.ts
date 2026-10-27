import { randomUUID } from "node:crypto";
import { lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/paths";
import { atomicWriteFileStreamed } from "../config/atomic-write";
import { ConfigMutationLockError, withConfigMutationLockSync } from "../config/mutation-lock";
import { readBoundedRegularFileSync } from "../lib/bounded-file-read";
import { acquireCredentialObservationLease, credentialObservationLeaseAlive, sweepDeadCredentialObservationLeases } from "./observation-lease";

/**
 * Durable coordination for the local-credential attestation in `ocx status --json`.
 *
 * `local-credentials.json` holds a random epoch, a sequence, pending publication tickets,
 * the private OS keychain accounts an instrumented writer touched, and the runtime observer's
 * coverage vector of file identities. It never holds a credential value or a hash of one. Every
 * instrumented credential write advances the sequence, so `lc1:<epoch>:<sequence>` changes even
 * when the final count is unchanged.
 */
type Ticket = { id: string; pid: number };
type Coverage = { owner: string; pid: number; vector: string };
export type CredentialGeneration = {
  version: 1;
  epoch: string;
  sequence: number;
  pending: Ticket[];
  keyAccounts: string[];
  coverage: Coverage | null;
};
const observers = new Map<string, () => void>();
const decoder = new TextDecoder("utf-8", { fatal: true });
const uuid = /^[0-9a-f-]{36}$/;
const LOCK_ATTEMPTS = 40;
const pathFor = (home: string) => join(home, "local-credentials.json");

export function observationAlive(state: CredentialGeneration, home = getConfigDir()): boolean {
  return !!state.coverage && credentialObservationLeaseAlive(home, state.coverage.owner);
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if (missing(error)) return false; throw error; }
}
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException)?.code !== "ESRCH"; }
}
export function readCredentialGeneration(home = getConfigDir()): CredentialGeneration | undefined {
  try {
    const path = pathFor(home);
    if (!lstatSync(path).isFile()) return undefined;
    const value: unknown = JSON.parse(decoder.decode(readBoundedRegularFileSync(path, 1024 * 1024)));
    if (!value || typeof value !== "object") return undefined;
    const s = value as CredentialGeneration;
    if (s.version !== 1 || typeof s.epoch !== "string" || !uuid.test(s.epoch)
      || !Number.isSafeInteger(s.sequence) || s.sequence < 0
      || !Array.isArray(s.pending) || s.pending.length > 1024
      || !s.pending.every(t => t && typeof t.id === "string" && uuid.test(t.id)
        && Number.isSafeInteger(t.pid) && t.pid > 0)
      || new Set(s.pending.map(t => t.id)).size !== s.pending.length
      || !Array.isArray(s.keyAccounts) || s.keyAccounts.length > 8192
      || !s.keyAccounts.every(k => typeof k === "string" && k.length > 0 && k.length <= 1024)
      || new Set(s.keyAccounts).size !== s.keyAccounts.length) return undefined;
    if (s.coverage !== null && (!s.coverage || typeof s.coverage.owner !== "string"
      || !uuid.test(s.coverage.owner) || !Number.isSafeInteger(s.coverage.pid)
      || s.coverage.pid <= 0 || typeof s.coverage.vector !== "string"
      || s.coverage.vector.length > 512 * 1024)) return undefined;
    return s;
  } catch { return undefined; }
}
function empty(): CredentialGeneration {
  return { version: 1, epoch: randomUUID(), sequence: 0, pending: [], keyAccounts: [], coverage: null };
}
/** Missing metadata starts a fresh epoch; unreadable metadata is never guessed over. */
function loadForWrite(home: string): CredentialGeneration {
  const state = readCredentialGeneration(home);
  if (state) return state;
  if (!exists(pathFor(home))) return empty();
  throw new Error("Local credential coordination metadata is unreadable; explicit recovery required");
}
function save(home: string, state: CredentialGeneration): void {
  atomicWriteFileStreamed(pathFor(home), fd => writeFileSync(fd, JSON.stringify(state) + "\n"));
}
function advance(state: CredentialGeneration): void {
  if (state.sequence >= Number.MAX_SAFE_INTEGER) { state.epoch = randomUUID(); state.sequence = 0; }
  else state.sequence += 1;
}
export function generationToken(state: CredentialGeneration): string {
  return `lc1:${state.epoch}:${state.sequence}`;
}
/**
 * The config lock never waits (busy_timeout=0). Writers that must not lose a ticket retry briefly
 * and synchronously; work that can be skipped or retried later takes one attempt.
 */
function locked<T>(home: string, fn: () => T, attempts = LOCK_ATTEMPTS): T {
  for (let attempt = 1; ; attempt++) {
    try { return withConfigMutationLockSync(fn, home); }
    catch (error) {
      if (attempt >= attempts || !(error instanceof ConfigMutationLockError)) throw error;
      Bun.sleepSync(25);
    }
  }
}

/**
 * Publishes a ticket before credential bytes change. A file publication without one is still
 * fenced, because the observer's identity vector no longer matches until it reconciles; so a
 * file write never fails for want of a ticket. A keychain write must record its account first.
 */
function begin(home: string, accounts: readonly string[]): Ticket | null {
  const required = accounts.length > 0;
  try {
    return locked(home, () => {
      if (!required && !exists(pathFor(home))) return null;
      const state = loadForWrite(home);
      if (state.pending.length >= 1024) throw new Error("Too many pending credential publications");
      if (accounts.some(a => !a || a.length > 1024)) throw new Error("Invalid private key account");
      const ticket = { id: randomUUID(), pid: process.pid };
      state.pending.push(ticket);
      state.keyAccounts = [...new Set([...state.keyAccounts, ...accounts])];
      if (state.keyAccounts.length > 8192) throw new Error("Too many private key accounts");
      advance(state);
      save(home, state);
      return ticket;
    }, required ? LOCK_ATTEMPTS : 1);
  } catch (error) {
    if (required) throw error;
    return null;
  }
}

/** Never throws: a ticket that cannot be closed keeps withholding attestation instead. */
function finish(home: string, ticket: Ticket | null, removed: readonly string[]): void {
  if (ticket) {
    try {
      locked(home, () => {
        const state = loadForWrite(home);
        if (!state.pending.some(t => t.id === ticket.id && t.pid === ticket.pid)) return;
        state.pending = state.pending.filter(t => t.id !== ticket.id);
        state.keyAccounts = state.keyAccounts.filter(k => !removed.includes(k));
        advance(state);
        save(home, state);
      });
    } catch { /* the pending ticket keeps the field omitted until a runtime restart clears it */ }
  }
  observers.get(home)?.();
}

export interface CredentialPublication {
  /** Private keychain accounts this write may create; they count until verified absent. */
  accounts?: readonly string[];
  /** After the write settles: accounts now verified absent, dropped from the registry. */
  absent?: (completed: boolean) => readonly string[];
}

export function publishCredentialSync<T>(write: () => T, publication: CredentialPublication = {}): T {
  const home = getConfigDir();
  const ticket = begin(home, publication.accounts ?? []);
  let completed = false;
  try {
    const result = write();
    if (result instanceof Promise) throw new Error("Synchronous credential publication returned a Promise");
    completed = true;
    return result;
  } finally {
    let removed: readonly string[] = [];
    try { removed = publication.absent?.(completed) ?? []; } catch { /* unverified stays counted */ }
    finish(home, ticket, removed);
  }
}
export async function publishCredentialAsync<T>(write: () => Promise<T>): Promise<T> {
  const home = getConfigDir();
  const ticket = begin(home, []);
  try { return await write(); }
  finally { finish(home, ticket, []); }
}

/**
 * Runtime start: refuse while another observer lives or a live writer holds a ticket, clear the
 * tickets of dead writers, start a new epoch and take the observer's OS lease.
 */
export function claimCredentialObservation(home: string, scan: (accounts: readonly string[]) => string): { owner: string; close(): void } {
  return locked(home, () => {
    const state = loadForWrite(home);
    if (observationAlive(state, home)) throw new Error("Credential observer already running");
    if (state.pending.some(t => processAlive(t.pid))) throw new Error("Credential publication still running");
    state.pending = [];
    state.epoch = randomUUID();
    state.sequence = 0;
    const owner = randomUUID();
    const lease = acquireCredentialObservationLease(home, owner);
    sweepDeadCredentialObservationLeases(home, owner);
    try {
      state.coverage = { owner, pid: process.pid, vector: scan(state.keyAccounts) };
      save(home, state);
      return { owner, close: () => lease.close() };
    } catch (error) { lease.close(); throw error; }
  });
}
/**
 * Advance on every observed event and rescan; a failed scan leaves an empty vector, which never
 * attests. One lock attempt: the runtime observer retries asynchronously instead of blocking.
 */
export function updateCredentialObservation(home: string, owner: string, scan: ((accounts: readonly string[]) => string) | null): void {
  locked(home, () => {
    const state = loadForWrite(home);
    if (state.coverage?.owner !== owner) return;
    advance(state);
    if (scan === null) state.coverage = null;
    else {
      try { state.coverage.vector = scan(state.keyAccounts); }
      catch { state.coverage.vector = ""; }
    }
    save(home, state);
  }, 1);
}
export function registerCredentialObserver(home: string, reconcile: () => void): () => void {
  if (observers.has(home)) throw new Error("Credential observer already registered");
  observers.set(home, reconcile);
  return () => { if (observers.get(home) === reconcile) observers.delete(home); };
}
