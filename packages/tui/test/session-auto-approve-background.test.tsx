import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { json } from "./fixture/tui-client"

type SessionInput = { id?: string; location?: { directory: string } }

const location = {
  directory: "/tmp/opencode/packages/tui",
  project: { id: "project", directory: "/tmp/opencode", canonical: "/tmp/opencode" },
}

function sessionInfo(record: SessionInput) {
  return {
    ...record,
    location: record.location ?? { directory: location.directory },
    projectID: "project",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
}

type Pending = { id: string; sessionID: string; action: string; resources: string[] }

// Launches the real TUI app with two prompted sessions; the second stays focused and the
// first is a background tab. Models the pending permissions a server would hold, so the
// store and the permission list endpoint stay consistent.
async function launchTwoSessions(auto: boolean) {
  const created: SessionInput[] = []
  const prompts: string[] = []
  const replies: { sessionID: string; requestID: string }[] = []
  const pending = new Map<string, Pending>()
  const setup = await createAppFixture({
    args: auto ? { auto: true } : {},
    config: { animations: false, keybinds: { "session.new": "f6" } },
    fetch: async (url, request) => {
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "demo", name: "Demo" }] })
      if (url.pathname === "/api/model")
        return json({ location, data: [{ id: "model", providerID: "demo", name: "Demo Model", variants: [] }] })
      if (url.pathname === "/api/session" && request.method === "POST") {
        const record: SessionInput = await request.json()
        created.push(record)
        return json({ data: sessionInfo(record) })
      }
      if (/^\/api\/session\/[^/]+\/prompt$/.test(url.pathname)) {
        prompts.push(url.pathname.split("/")[3] ?? "")
        return json({ data: {} })
      }
      if (/^\/api\/session\/[^/]+\/permission$/.test(url.pathname)) {
        const sessionID = url.pathname.split("/")[3] ?? ""
        return json({ data: [...pending.values()].filter((item) => item.sessionID === sessionID) })
      }
      if (request.method === "POST" && /^\/api\/session\/[^/]+\/permission\/[^/]+\/reply$/.test(url.pathname)) {
        const [, , , sessionID, , requestID] = url.pathname.split("/")
        pending.delete(requestID)
        replies.push({ sessionID, requestID })
        return json({ data: {} })
      }
      if (/^\/api\/session\/[^/]+\/(message|inbox|form)$/.test(url.pathname)) return json({ data: [], cursor: {} })
      if (/^\/api\/session\/[^/]+\/(agent|model)$/.test(url.pathname)) return new Response(null, { status: 204 })
      if (/^\/api\/session\/[^/]+$/.test(url.pathname)) {
        const record = created.find((item) => item.id === url.pathname.split("/")[3])
        if (!record) return json({ message: "not found" }, { status: 404 })
        return json({ data: sessionInfo(record) })
      }
      return undefined
    },
  })
  return { setup, created, prompts, replies, pending }
}

async function until(condition: () => boolean, ms = 5000) {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition")
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function openTwoSessions(run: Awaited<ReturnType<typeof launchTwoSessions>>) {
  const setup = run.setup
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("Demo Model"))
  await setup.mockInput.typeText("first")
  setup.mockInput.pressEnter()
  await until(() => run.prompts.length === 1)
  setup.mockInput.pressKey("F6")
  await setup.waitForFrame((frame) => frame.includes("Ask anything"))
  await setup.mockInput.typeText("second")
  setup.mockInput.pressEnter()
  await until(() => run.prompts.length === 2 && run.created.length === 2)
}

function ask(id: string, sessionID: string) {
  return {
    id: `evt_${id}`,
    created: 1,
    type: "permission.asked" as const,
    data: { id, sessionID, action: "shell", resources: ["bun run test"] },
  }
}

test("auto-approves a background tab's permission ask without selecting the tab", async () => {
  const run = await launchTwoSessions(true)
  await using setup = run.setup

  await openTwoSessions(run)

  const background = run.created[0]?.id ?? ""
  const focused = run.created[1]?.id ?? ""
  expect(background).toBeTruthy()
  expect(focused).toBeTruthy()
  setup.events.emit(ask("per_bg", background))
  run.pending.set("per_bg", { id: "per_bg", sessionID: background, action: "shell", resources: ["bun run test"] })

  // The ask sits on a tab that was never selected; --auto must answer it from the connection.
  await until(() => run.replies.length > 0)
  expect(run.replies).toEqual([{ sessionID: background, requestID: "per_bg" }])

  // Selecting the background tab must not answer a second time.
  setup.mockInput.pressKey("1", { ctrl: true })
  await setup.renderOnce()
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(run.replies).toEqual([{ sessionID: background, requestID: "per_bg" }])
})

test("still answers a focused session's permission ask immediately", async () => {
  const run = await launchTwoSessions(true)
  await using setup = run.setup

  await openTwoSessions(run)

  const focused = run.created[1]?.id ?? ""
  setup.events.emit(ask("per_focused", focused))
  run.pending.set("per_focused", {
    id: "per_focused",
    sessionID: focused,
    action: "shell",
    resources: ["bun run test"],
  })

  await until(() => run.replies.length > 0)
  expect(run.replies).toEqual([{ sessionID: focused, requestID: "per_focused" }])
})

test("prompt mode leaves permission asks for the user", async () => {
  const run = await launchTwoSessions(false)
  await using setup = run.setup

  await openTwoSessions(run)

  const focused = run.created[1]?.id ?? ""
  setup.events.emit(ask("per_prompt", focused))
  run.pending.set("per_prompt", {
    id: "per_prompt",
    sessionID: focused,
    action: "shell",
    resources: ["bun run test"],
  })

  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(run.replies).toEqual([])
})
