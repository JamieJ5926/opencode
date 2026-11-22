import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const CHILD = path.join(import.meta.dir, "fixture/mcp-process-guard/server-child.ts")
const WRAPPER = path.join(import.meta.dir, "fixture/mcp-process-guard/wrapper.mjs")
const STUB = path.join(import.meta.dir, "fixture/mcp-process-guard/stub-server.mjs")

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const until = async (condition: () => boolean, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !condition()) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return condition()
}

interface Pids {
  wrapper: number
  stub: number
}

/** Starts the stand-in server, waits until the wrapper and its server report their pids. */
async function startServer() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mcp-process-guard-"))
  const pidsFile = path.join(dir, "transport.json")
  const stubPidFile = path.join(dir, "stub.pid")
  const child = spawn(process.execPath, [CHILD, pidsFile, process.execPath, WRAPPER, STUB, stubPidFile], {
    stdio: ["ignore", "ignore", "inherit"],
    // The child stands in for the opencode server: its own process group leader.
    detached: true,
  })
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)))
  const ready = await until(() => {
    try {
      return typeof JSON.parse(readFileSync(pidsFile, "utf8")).wrapper === "number" && readFileSync(stubPidFile, "utf8") !== ""
    } catch {
      return false
    }
  }, 15_000)
  // A failed start must not leak the detached child: it would hold this runner open forever.
  if (!ready) {
    try {
      if (child.pid) process.kill(child.pid, "SIGKILL")
    } catch {}
    throw new Error("the stand-in server never became ready")
  }
  const parsed = JSON.parse(readFileSync(pidsFile, "utf8")) as { wrapper: number }
  const pids: Pids = { wrapper: parsed.wrapper, stub: Number(readFileSync(stubPidFile, "utf8")) }
  const cleanup = () => {
    for (const pid of [pids.wrapper, pids.stub]) {
      try {
        process.kill(-pid, "SIGKILL")
      } catch {}
      try {
        process.kill(pid, "SIGKILL")
      } catch {}
    }
    rmSync(dir, { recursive: true, force: true })
  }
  return { child, exited, pids, cleanup }
}

test("a SIGKILLed server leaves no wrapper or server behind", async () => {
  const { child, exited, pids, cleanup } = await startServer()
  try {
    expect(alive(pids.wrapper)).toBe(true)
    expect(alive(pids.stub)).toBe(true)

    // The reported path: the server is SIGKILLed on its own pid, so no exit hook runs and nothing
    // kills the stack it spawned. The wrapper and its server must die anyway.
    process.kill(child.pid!, "SIGKILL")
    await exited

    const gone = await until(() => !alive(pids.wrapper) && !alive(pids.stub), 10_000)
    expect(gone).toBe(true)
  } finally {
    cleanup()
  }
}, 30_000)

test("a graceful close still stops the wrapper and its server", async () => {
  const { child, exited, pids, cleanup } = await startServer()
  try {
    process.kill(child.pid!, "SIGUSR2")
    await exited

    const gone = await until(() => !alive(pids.wrapper) && !alive(pids.stub), 10_000)
    expect(gone).toBe(true)
  } finally {
    cleanup()
  }
}, 30_000)
