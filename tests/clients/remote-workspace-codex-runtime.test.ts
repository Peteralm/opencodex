import { repoPath } from "../helpers/repo-root";
import { expect, spyOn, test } from "bun:test";
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  CodexRemoteWorkspaceRuntimeFactory,
  RemoteWorkspaceCoordinator,
  type RemoteWorkspaceRuntimeFactory,
  type RemoteWorkspaceSessionEvent,
  type RemoteWorkspaceTransport,
} from "../../src/remote-control";
import { removeTreeWithRetry } from "../helpers/remove-tree";

test("Codex Remote Workspace runtime owns the model process on the Hub", async () => {
  const events: Array<{ type: RemoteWorkspaceSessionEvent["type"]; text: string }> = [];
  const transport: RemoteWorkspaceTransport = {
    isOnline: () => true,
    async invoke() { return { ok: true, value: null }; },
  };
  const coordinator = new RemoteWorkspaceCoordinator(transport);
  const factory = new CodexRemoteWorkspaceRuntimeFactory({
    command: [process.execPath, repoPath("tests", "fake-codex-server.ts")],
    version: "0.146.0-test",
    env: {
      FAKE_CODEX_SCRIPT: JSON.stringify({
        turns: [{
          notifications: [{
            method: "item/completed",
            params: { item: { id: "answer-1", type: "agentMessage", text: "Done from Computer 1" } },
          }],
        }],
      }),
    },
  });

  expect(await factory.available()).toEqual({ available: true, version: "0.146.0-test" });
  const handle = await factory.start({
    sessionId: "session-1",
    deviceId: "device-2",
    deviceName: "Computer 2",
    rootId: "root-2",
    rootLabel: "Project",
    capabilities: ["workspace.read", "workspace.write", "workspace.exec"],
    tools: ["list_directory", "read_file", "write_file", "exec"],
    coordinator,
    emit: (type, text) => events.push({ type, text }),
  });
  const unregister = coordinator.register({
    sessionId: "session-1",
    threadId: handle.threadId,
    executorDeviceId: "device-2",
    executorName: "Computer 2",
    rootId: "root-2",
    capabilities: ["workspace.read", "workspace.write", "workspace.exec"],
    tools: ["list_directory", "read_file", "write_file", "exec"],
  });
  try {
    await handle.prompt("Inspect the remote project");
    expect(events).toContainEqual({ type: "assistant", text: "Done from Computer 1" });
  } finally {
    unregister();
    await handle.stop();
  }
});

test("Codex Remote Workspace stop interrupts a held turn", async () => {
  const coordinator = new RemoteWorkspaceCoordinator({
    isOnline: () => true,
    async invoke() { return { ok: true }; },
  });
  const factory = new CodexRemoteWorkspaceRuntimeFactory({
    command: [process.execPath, repoPath("tests", "fake-codex-server.ts")],
    env: { FAKE_CODEX_SCRIPT: JSON.stringify({ turns: [{ heldUntilInterrupt: true }] }) },
  });
  const handle = await factory.start({
    sessionId: "session-1",
    deviceId: "device-2",
    deviceName: "Computer 2",
    rootId: "root-2",
    rootLabel: "Project",
    capabilities: ["workspace.read", "workspace.write", "workspace.exec"],
    tools: ["list_directory", "read_file", "write_file", "exec"],
    coordinator,
    emit: () => {},
  });
  coordinator.register({
    sessionId: "session-1",
    threadId: handle.threadId,
    executorDeviceId: "device-2",
    executorName: "Computer 2",
    rootId: "root-2",
    capabilities: ["workspace.read", "workspace.write", "workspace.exec"],
    tools: ["list_directory", "read_file", "write_file", "exec"],
  });
  const turn = handle.prompt("Hold this turn").then(() => "resolved", () => "rejected");
  await new Promise(resolvePromise => setTimeout(resolvePromise, 30));
  await handle.stop();
  expect(await turn).toBe("rejected");
});

test("Codex Remote Workspace resumes the persisted App Server thread ID", async () => {
  const factory = new CodexRemoteWorkspaceRuntimeFactory({
    command: [process.execPath, repoPath("tests", "fake-codex-server.ts")],
  });
  const coordinator = new RemoteWorkspaceCoordinator({
    isOnline: () => true,
    async invoke() { return { ok: true }; },
  });
  const handle = await factory.start({
    sessionId: "session-resume",
    deviceId: "device-2",
    deviceName: "Computer 2",
    rootId: "root-2",
    rootLabel: "Project",
    capabilities: ["workspace.read"],
    tools: ["list_directory", "read_file"],
    resumeThreadId: "thread-persisted",
    coordinator,
    emit: () => {},
  });
  expect(handle.threadId).toBe("thread-persisted");
  await handle.stop();
});

/** A stdio JSON-RPC double: answers the exact handshake start() performs, spawns nothing real. */
function fakeCodexAppServerChild(received: Record<string, unknown>[]) {
  const encoder = new TextEncoder();
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({ start(controller) { stdoutController = controller; } });
  let stderrController!: ReadableStreamDefaultController<Uint8Array>;
  const stderr = new ReadableStream<Uint8Array>({ start(controller) { stderrController = controller; } });
  let exitedResolve!: (code: number) => void;
  const exited = new Promise<number>(resolvePromise => { exitedResolve = resolvePromise; });
  let finished = false;
  function finish(): void {
    if (finished) return;
    finished = true;
    child.exitCode = 0;
    stdoutController.close();
    stderrController.close();
    exitedResolve(0);
  }
  const child = {
    pid: 4242,
    exitCode: null as number | null,
    signalCode: null,
    stdin: {
      write(chunk: string | Uint8Array) {
        const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          const message = JSON.parse(line) as Record<string, unknown>;
          received.push(message);
          if (message.id === undefined) continue;
          const result = message.method === "initialize" ? {}
            : message.method === "config/read" ? { config: {} }
            : message.method === "thread/start" ? { thread: { id: "thread-fake" } }
            : {};
          stdoutController.enqueue(encoder.encode(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`));
        }
        return 1;
      },
      flush() {},
      end() { finish(); },
    },
    stdout,
    stderr,
    exited,
    kill() { finish(); },
  };
  return child as unknown as Bun.Subprocess<"pipe", "pipe", "pipe">;
}

interface SpawnedInvocation { argv: string[]; options: unknown }

function captureSpawns(received: Record<string, unknown>[]) {
  const spawns: SpawnedInvocation[] = [];
  const spawn = spyOn(Bun, "spawn").mockImplementation(((argv: readonly string[], options: unknown) => {
    spawns.push({ argv: [...argv], options });
    return fakeCodexAppServerChild(received);
  }) as never);
  return { spawns, spawn };
}

function remoteWorkspaceStartOptions(): Parameters<RemoteWorkspaceRuntimeFactory["start"]>[0] {
  return {
    sessionId: "session-boundary",
    deviceId: "device-3",
    deviceName: "Computer 3",
    rootId: "root-3",
    rootLabel: "Project",
    capabilities: ["workspace.read"],
    tools: ["list_directory", "read_file"],
    coordinator: new RemoteWorkspaceCoordinator({ isOnline: () => true, async invoke() { return { ok: true }; } }),
    emit: () => {},
  };
}

test("a Windows .cmd target reaches spawn inside its ComSpec /d /s /c wrapper", async () => {
  const comspec = "C:\\Windows\\System32\\cmd.exe";
  const root = mkdtempSync(join(tmpdir(), "ocx-remote-cmd-"));
  // The target must be a real native binary: on Linux the permission-profile helper check
  // opens it, so a plain-text .cmd would fail before the spawn composition is reached.
  const codexCmd = join(root, "codex.cmd");
  try { linkSync(process.execPath, codexCmd); } catch { copyFileSync(process.execPath, codexCmd); }
  const received: Record<string, unknown>[] = [];
  const { spawns, spawn } = captureSpawns(received);
  const factory = new CodexRemoteWorkspaceRuntimeFactory({
    command: [codexCmd],
    env: { ComSpec: comspec },
    execDeps: { platform: "win32", env: { ComSpec: comspec, PATH: "", PATHEXT: ".CMD;.EXE" } },
  });
  let handle: Awaited<ReturnType<RemoteWorkspaceRuntimeFactory["start"]>> | undefined;
  try {
    handle = await factory.start(remoteWorkspaceStartOptions());
    expect(handle.threadId).toBe("thread-fake");
  } finally {
    try { await handle?.stop(); }
    finally {
      spawn.mockRestore();
      removeTreeWithRetry(root);
    }
  }
  // The boundary answers ComSpec for a .cmd target; command[0] must keep the located
  // executablePath so this launcher rebuilds the /d /s /c line the payload rides in.
  expect(spawns).toHaveLength(1);
  expect(spawns[0]!.argv[0]).toBe(comspec);
  expect(spawns[0]!.argv.slice(1, 4)).toEqual(["/d", "/s", "/c"]);
  expect(spawns[0]!.argv[4]).toContain("codex.cmd");
  expect(spawns[0]!.argv[4]).toContain("app-server");
  expect(spawns[0]!.options).toMatchObject({ windowsVerbatimArguments: true });
  expect(received.map(message => message.method)).toEqual(["initialize", "initialized", "config/read", "thread/start"]);
});

// The fake bundle must be real on disk: start() canonicalizes executablePath with real
// realpathSync, and macOS path grammar cannot be expressed with Windows-shaped paths.
test.skipIf(process.platform === "win32")("a macOS bundle alias is replaced by the canonical checked binary", async () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-remote-mac-home-"));
  const bundleBinary = join(home, "Applications", "ChatGPT.app", "Contents", "Resources", "codex-cli", "bin", "codex");
  mkdirSync(dirname(bundleBinary), { recursive: true });
  try { linkSync(process.execPath, bundleBinary); } catch { copyFileSync(process.execPath, bundleBinary); }
  const canonicalBinary = realpathSync(bundleBinary);
  const aliasRoot = mkdtempSync(join(tmpdir(), "ocx-remote-mac-alias-"));
  const alias = join(aliasRoot, "codex");
  symlinkSync(bundleBinary, alias);
  const received: Record<string, unknown>[] = [];
  const { spawns, spawn } = captureSpawns(received);
  const factory = new CodexRemoteWorkspaceRuntimeFactory({
    command: [alias],
    execDeps: {
      platform: "darwin",
      env: { HOME: home, PATH: "" },
      exists: () => true,
      executable: () => true,
      realpath: path => { try { return realpathSync(path); } catch { return null; } },
      macBundleTrustReasonAsync: async () => null,
    },
  });
  let handle: Awaited<ReturnType<RemoteWorkspaceRuntimeFactory["start"]>> | undefined;
  try {
    handle = await factory.start(remoteWorkspaceStartOptions());
    expect(handle.threadId).toBe("thread-fake");
  } finally {
    try { await handle?.stop(); }
    finally {
      spawn.mockRestore();
      try { removeTreeWithRetry(home); }
      finally { removeTreeWithRetry(aliasRoot); }
    }
  }
  // A symlinked alias cannot carry the trust decision: the Hub execs only the canonical
  // binary the boundary checked.
  expect(spawns).toHaveLength(1);
  expect(spawns[0]!.argv[0]).toBe(canonicalBinary);
  expect(spawns[0]!.argv[0]).not.toBe(alias);
});
