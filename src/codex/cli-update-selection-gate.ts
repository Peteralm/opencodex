/**
 * Shared commit fence and selection gate for the Codex CLI update worker.
 *
 * The update's last synchronous turn (final process scan, prefix/preimage/
 * selection guards, installer spawn) runs inside a Worker realm now, so the
 * old same-event-loop-turn argument no longer excludes the parent's own
 * selection-mutating operations or its session-spawn paths. Two shared-memory
 * primitives carry that exclusion across realms:
 *
 * - FENCE (one per dispatched job): the parent's only cancellation word is
 *   PREPARING -> CANCELLED, and the worker's only commit word is
 *   PREPARING -> COMMITTED. Exactly one compareExchange wins. A cancel that
 *   lands first is observed by the worker's isCancelled checkpoints and by
 *   the commit CAS losing; a commit is the irrevocable start decision, not
 *   evidence of successful spawn. Later cancellation is deferred to readback.
 *
 * - GATE (one process-wide cell): FREE -> PARENT_WRITE is taken by the five
 *   parent selection writers (runtime pin persist/clear, shim install/
 *   auto-restore/uninstall) and the two parent session-spawn paths (remote
 *   workspace child, desktop relaunch). FREE -> WORKER_COMMIT is taken by the
 *   update worker through installer settlement and post-install readback. Writers report busy rather
 *   than wait: Windows final ACL/content observations may be slow; a parent writer
 *   must never park the event loop behind it. The gate is intentionally one
 *   cell for the whole process rather than per-configDir: alias/junction/case
 *   spellings of the same target must not split the exclusion, so a writer on
 *   a different configDir can also see busy until installation settles.
 *
 * This module claims nothing about processes it does not own: an external
 * installer, a late descendant of an earlier child, or an OS snapshot race
 * stays the documented residual it always was.
 */

export const CODEX_CLI_UPDATE_FENCE_PREPARING = 0;
export const CODEX_CLI_UPDATE_FENCE_CANCELLED = 1;
export const CODEX_CLI_UPDATE_FENCE_COMMITTED = 2;

export const CODEX_CLI_UPDATE_GATE_FREE = 0;
export const CODEX_CLI_UPDATE_GATE_PARENT_WRITE = 1;
export const CODEX_CLI_UPDATE_GATE_WORKER_COMMIT = 2;

/** Bounded wait for a parent writer's window; the worker then refuses busy. */
const WORKER_COMMIT_WAIT_DEADLINE_MS = 30_000;

export class CodexCliSelectionMutationBusyError extends Error {
  constructor(message = "codex_cli_selection_busy") {
    super(message);
    this.name = "CodexCliSelectionMutationBusyError";
  }
}

let selectionGate: SharedArrayBuffer | null = null;

/** The single process-wide gate cell. Both realms wrap it in an Int32Array. */
export function codexCliUpdateSelectionGate(): SharedArrayBuffer {
  selectionGate ??= new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT);
  return selectionGate;
}

/** Test seam: drop the cell so each case starts from FREE on a fresh buffer. */
export function resetCodexCliSelectionGatesForTests(): void {
  selectionGate = null;
}

/** Fresh per-job fence; SharedArrayBuffer zero-initializes to PREPARING. */
export function createCodexCliUpdateFence(): SharedArrayBuffer {
  return new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
}

/** Parent cancel word. True only when this CAS took PREPARING -> CANCELLED. */
export function cancelCodexCliUpdateFence(fence: SharedArrayBuffer): boolean {
  return Atomics.compareExchange(new Int32Array(fence), 0,
    CODEX_CLI_UPDATE_FENCE_PREPARING, CODEX_CLI_UPDATE_FENCE_CANCELLED) === CODEX_CLI_UPDATE_FENCE_PREPARING;
}

/**
 * The worker-side cancellation checkpoint fed to apply's isCancelled hook.
 * COMMITTED is deliberately not "cancelled": once the commit CAS lands the
 * installer is a live child whose close must be observed, not a cancel.
 */
export function codexCliUpdateIsCancelled(fence: SharedArrayBuffer): () => boolean {
  const view = new Int32Array(fence);
  return () => Atomics.load(view, 0) === CODEX_CLI_UPDATE_FENCE_CANCELLED;
}

export interface CodexCliSelectionParentWrite {
  readonly entered: boolean;
  /** Idempotent release; safe to call from both branches of a spawn attempt. */
  exit(): void;
}

/**
 * Non-blocking acquisition for the parent selection writers and session-spawn
 * paths. entered === false means a commit window (or another writer) is in
 * flight and the caller must surface busy immediately, never wait.
 */
export function beginCodexCliSelectionParentWrite(): CodexCliSelectionParentWrite {
  const view = new Int32Array(codexCliUpdateSelectionGate());
  if (Atomics.compareExchange(view, 0, CODEX_CLI_UPDATE_GATE_FREE, CODEX_CLI_UPDATE_GATE_PARENT_WRITE)
    !== CODEX_CLI_UPDATE_GATE_FREE) {
    return Object.freeze({ entered: false, exit() { /* nothing held */ } });
  }
  let held = true;
  return Object.freeze({
    entered: true,
    exit() {
      if (!held) return;
      held = false;
      Atomics.store(view, 0, CODEX_CLI_UPDATE_GATE_FREE);
    },
  });
}

/**
 * The worker's installation window. tryEnter covers the uncontended same-turn
 * case; waitEnter is the bounded retry for a held parent write. commit() is
 * the fence CAS issued in the same event-loop turn as the installer start call;
 * exit() releases only after proven termination and post-install readback.
 * Unknown child lifetime retains exclusion. Slots 1/2 bind owner/generation;
 * one-word legacy fixtures have no parent recovery authority.
 */
export interface CodexCliUpdateCommitWindow {
  tryEnter(): boolean;
  waitEnter(): Promise<boolean>;
  commit(): boolean;
  exit(): void;
}

export function createWorkerCommitWindow(options: {
  readonly gate: SharedArrayBuffer;
  readonly fence: SharedArrayBuffer;
  readonly generation?: number;
  readonly deadlineMs?: number;
  /** Test seam: observe/back-off without real sleeps. */
  readonly sleep?: (ms: number) => Promise<void>;
}): CodexCliUpdateCommitWindow {
  const gate = new Int32Array(options.gate);
  const fence = new Int32Array(options.fence);
  const deadlineMs = options.deadlineMs ?? WORKER_COMMIT_WAIT_DEADLINE_MS;
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const cancelled = () => Atomics.load(fence, 0) === CODEX_CLI_UPDATE_FENCE_CANCELLED;
  const generation = options.generation ?? reserveCodexCliInstallationGeneration(options.gate);
  if (!Number.isInteger(generation) || generation <= 0 || generation > 0x7fffffff) throw new Error("invalid_installation_generation");
  const enter = () => {
    if (Atomics.compareExchange(gate, 0, CODEX_CLI_UPDATE_GATE_FREE, -generation)
      !== CODEX_CLI_UPDATE_GATE_FREE) return false;
    if (gate.length >= 3) Atomics.store(gate, 1, generation);
    Atomics.store(gate, 0, CODEX_CLI_UPDATE_GATE_WORKER_COMMIT);
    return true;
  };
  let held = false;
  return Object.freeze({
    tryEnter() {
      if (!held && enter()) {
        held = true;
      }
      return held;
    },
    async waitEnter() {
      const deadline = Date.now() + deadlineMs;
      while (!held && !cancelled()) {
        if (enter()) {
          held = true;
          break;
        }
        if (Date.now() >= deadline) break;
        await sleep(1);
      }
      return held;
    },
    commit() {
      return Atomics.compareExchange(fence, 0, CODEX_CLI_UPDATE_FENCE_PREPARING, CODEX_CLI_UPDATE_FENCE_COMMITTED)
        === CODEX_CLI_UPDATE_FENCE_PREPARING;
    },
    exit() {
      if (!held) return;
      held = false;
      releaseCodexCliInstallationGeneration(options.gate, generation);
    },
  });
}

/** Process-wide monotonic owner token; never reuse a wrapped generation. */
export function reserveCodexCliInstallationGeneration(buffer: SharedArrayBuffer): number {
  const view = new Int32Array(buffer);
  if (view.length < 3) return 1; // Legacy isolated fixture, no recovery.
  for (;;) {
    const previous = Atomics.load(view, 2);
    if (previous < 0 || previous === 0x7fffffff) throw new Error("installation_generation_exhausted");
    if (Atomics.compareExchange(view, 2, previous, previous + 1) === previous) return previous + 1;
  }
}

function releaseCodexCliInstallationGeneration(buffer: SharedArrayBuffer, generation: number): boolean {
  const view = new Int32Array(buffer);
  if (view.length >= 3 && Atomics.load(view, 1) !== generation) return false;
  if (Atomics.compareExchange(view, 0, CODEX_CLI_UPDATE_GATE_WORKER_COMMIT, -generation)
    !== CODEX_CLI_UPDATE_GATE_WORKER_COMMIT) return false;
  if (view.length >= 3) Atomics.store(view, 1, 0);
  Atomics.store(view, 0, CODEX_CLI_UPDATE_GATE_FREE);
  return true;
}

/** Parent recovery is limited to an observed dead Worker that never won commit.
 * COMMITTED is irrevocable: death/timeout/PID absence cannot establish child death.
 * A surviving worker releases its own generation only after native Job settlement.
 */
export function recoverCodexCliInstallationAfterWorkerClose(buffer: SharedArrayBuffer,
  fence: SharedArrayBuffer, generation: number): boolean {
  if (buffer.byteLength < 12 || Atomics.load(new Int32Array(fence), 0) === CODEX_CLI_UPDATE_FENCE_COMMITTED) return false;
  const view = new Int32Array(buffer);
  // Worker death can land between gate reservation and owner publication, or
  // midway through release. The reserved negative word is itself exact ownership.
  if (Atomics.load(view, 0) === -generation) {
    Atomics.store(view, 1, 0);
    return Atomics.compareExchange(view, 0, -generation, CODEX_CLI_UPDATE_GATE_FREE) === -generation;
  }
  return releaseCodexCliInstallationGeneration(buffer, generation);
}
