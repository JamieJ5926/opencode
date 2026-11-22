export * as ServerProcess from "./server-process"

import { NodeServices } from "@effect/platform-node"
import { Service } from "@opencode/client/effect/service"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { OPENCODE_ARTIFACT, OPENCODE_CHANNEL, OPENCODE_VERSION } from "./version"
import { AppProcess } from "@opencode/util/process"
import { randomBytes, randomUUID } from "node:crypto"
import { Effect, Option, Redacted, Schema } from "effect"
import { PersistentPty } from "@opencode/schema/persistent-pty"
import { HttpServer } from "effect/http"
import { NetAddress } from "effect/net"
import { Env } from "./env"
import { PortOwner } from "./services/port-owner"
import { ServiceConfig } from "./services/service-config"
import { RetainedImage } from "./services/retained-image"
import { ServiceRegistration } from "./services/service-registration"
import { RemoteTunnel } from "./services/remote-tunnel"
import { WebUi } from "./services/web-ui"
import { databasePath } from "./database-path"

export type Mode = "default" | "service" | "stdio"

export type Options = {
  readonly mode: Mode
  readonly hostname?: string
  readonly port?: number
  readonly cors?: readonly string[]
}

// The process effect lives until server shutdown; tracing it would parent every request to one process-lifetime trace.
export const run = Effect.fnUntraced(function* (options: Options) {
  return yield* processEffect(options).pipe(
    Effect.provide(
      LayerNode.compile(LayerNode.group([Global.node, AppProcess.node]), {
        replacements: [
          Global.node.replace(
            Global.layerWith(process.env.OPENCODE_CONFIG_DIR ? { config: process.env.OPENCODE_CONFIG_DIR } : {}),
          ),
        ],
      }),
    ),
    Effect.provide(NodeServices.layer),
  )
})

const processEffect = Effect.fnUntraced(function* (options: Options) {
  const inherited = process.env.OPENCODE_PTY_HANDOFF
  delete process.env.OPENCODE_PTY_HANDOFF
  const handoff =
    inherited === undefined
      ? undefined
      : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PersistentPty.Handoff))(inherited).pipe(
          Effect.catch(() =>
            Effect.logWarning("Ignoring invalid PTY restart handoff; persistent terminals will start fresh").pipe(
              Effect.as(undefined),
            ),
          ),
        )
  const global = yield* Global.Service
  // A sandbox may deny $HOME; the service then keeps the cwd it was launched from.
  if (options.mode === "service")
    yield* Effect.try(() => process.chdir(global.home)).pipe(
      Effect.catch((cause) => Effect.logWarning("failed to change service directory to home", { cause })),
    )
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const foreground = options.mode === "default"
      const serviceOptions = options.mode === "service" ? yield* ServiceConfig.options() : undefined
      const config = options.mode === "service" ? yield* ServiceConfig.read() : {}
      const hostname = options.hostname ?? config.hostname ?? "127.0.0.1"
      const port = options.port ?? config.port ?? (options.mode === "service" ? ServiceConfig.defaultPort() : undefined)
      const findIncumbent =
        serviceOptions !== undefined && port !== undefined
          ? Service.incumbent({ ...serviceOptions, url: serviceURL(hostname, port) })
          : undefined
      if (findIncumbent !== undefined && (yield* findIncumbent) !== undefined) return
      // Desktop can launch the service directly without injecting its saved environment.
      Object.assign(process.env, ServiceConfig.processEnv(config.env))
      // Keep a package-manager or curl install replaceable while the service runs; Desktop updates its own copy.
      if (options.mode === "service" && process.platform === "win32" && RetainedImage.installed(global.home))
        yield* RetainedImage.retain(global.cache, "service")
      const { start } = yield* Effect.promise(() => import("@opencode/server/process"))
      const environmentPassword = yield* Env.password
      // Keep the lease credential out of the environment inherited by tools.
      if (options.mode === "stdio") {
        delete process.env.OPENCODE_PASSWORD
        delete process.env.OPENCODE_SERVER_PASSWORD
      }
      const password =
        options.mode === "service"
          ? config.password || randomBytes(32).toString("base64url")
          : environmentPassword
            ? Redacted.value(environmentPassword)
            : randomBytes(32).toString("base64url")
      if (!password) return yield* Effect.fail(new Error("Missing server password"))
      const instanceID = randomUUID()
      const transform = yield* WebUi.handler()
      const remote = { urls: [] as ReadonlyArray<string> }
      const launch = start(
        {
          app: {
            name: process.env.OPENCODE_CLIENT ?? OPENCODE_ARTIFACT,
            version: OPENCODE_VERSION,
            channel: OPENCODE_CHANNEL,
          },
          hostname,
          port,
          cors: options.cors ?? config.cors,
          password,
          pty: { handoff },
          simulation: truthy(process.env.OPENCODE_SIMULATE),
          database: {
            path: databasePath(global.data),
          },
          models: {
            url: process.env.OPENCODE_MODELS_URL,
            file: process.env.OPENCODE_MODELS_PATH,
            fetch: !truthy(process.env.OPENCODE_DISABLE_MODELS_FETCH),
          },
          config: {
            directory: process.env.OPENCODE_CONFIG_DIR,
            project: !truthy(
              process.env.OPENCODE_CONFIG_PROJECT_DISABLE ?? process.env.OPENCODE_DISABLE_PROJECT_CONFIG,
            ),
            // Config reads .claude only for skills; CLAUDE.md is gated under instructions.
            claude: !(
              truthy(process.env.OPENCODE_DISABLE_CLAUDE_CODE) ||
              truthy(process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS)
            ),
            file: process.env.OPENCODE_CONFIG,
            content: process.env.OPENCODE_CONFIG_CONTENT,
          },
          instructions: {
            claude: !(
              truthy(process.env.OPENCODE_DISABLE_CLAUDE_CODE) ||
              truthy(process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT)
            ),
          },
          windows: {
            gitbash: process.env.OPENCODE_GIT_BASH_PATH,
          },
          fs: {
            filewatcher: !truthy(process.env.OPENCODE_FILEWATCHER_DISABLE ?? process.env.OPENCODE_DISABLE_FILEWATCHER),
            fff:
              process.env.OPENCODE_DISABLE_FFF === undefined
                ? process.platform !== "win32"
                : !truthy(process.env.OPENCODE_DISABLE_FFF),
          },
        },
        serviceOptions === undefined
          ? undefined
          : {
              onListen: (address, shutdown) =>
                Effect.gen(function* () {
                  if (!config.password) yield* ServiceConfig.password(password)
                  return yield* ServiceRegistration.register({
                    address,
                    password,
                    id: instanceID,
                    file: serviceOptions.file,
                    shutdown,
                  })
                }),
            },
        transform,
        () => remote.urls,
      )
      const server = yield* launch.pipe(
        Effect.catch((error) => {
          if (findIncumbent === undefined || !addressInUse(error)) return Effect.fail(error)
          return Effect.gen(function* () {
            // The registration could not name the incumbent, so ask the port who holds it. An owner that
            // answers like an opencode server is a managed service that lost its registration; it frees
            // the port itself, so the bind retry below races that shutdown. A foreign or silent owner
            // never frees the port: retrying the bind cannot succeed, so fail at once naming the owner.
            const probe =
              port === undefined ? undefined : yield* Effect.promise(() => probePortOwner(port, hostname, config.password))
            if (probe === "foreign" && port !== undefined) {
              const owner = yield* PortOwner.describe(port, hostname)
              return yield* Effect.fail(new Error(portInUseMessage(port, hostname, owner), { cause: error }))
            }
            const deadline = Date.now() + 15_000
            while (Date.now() < deadline) {
              const found = yield* findIncumbent.pipe(Effect.timeoutOption(deadline - Date.now()))
              if (Option.isSome(found) && found.value !== undefined) return
              yield* Effect.sleep("100 millis")
              if (Date.now() >= deadline) break
              // Failed binds close their scope; a successful bind may take longer than this window to boot.
              const server = yield* launch.pipe(Effect.catchIf(addressInUse, () => Effect.void))
              if (server !== undefined) return server
            }
            const owner = port === undefined ? undefined : yield* PortOwner.describe(port, hostname)
            return yield* Effect.fail(new Error(portInUseMessage(port, hostname, owner), { cause: error }))
          })
        }),
      )
      if (server === undefined) return
      if (serviceOptions !== undefined && config.remote !== undefined && NetAddress.isInetAddress(server.address)) {
        const bound = NetAddress.formatIp(server.address.address)
        // A wildcard bind also listens on loopback, which is all the tunnel needs to reach.
        const target =
          bound === "0.0.0.0" || bound === "::"
            ? `127.0.0.1:${server.address.port}`
            : NetAddress.formatInet(server.address)
        yield* Effect.forkScoped(
          RemoteTunnel.run({
            route: config.remote.route,
            target,
            onURL: (url) => {
              remote.urls = url === undefined ? [] : [url]
            },
          }),
        )
      }
      const url = HttpServer.formatAddress(server.address)
      console.log(options.mode === "stdio" ? JSON.stringify({ url }) : `server listening on ${url}`)
      if (foreground && !environmentPassword) console.log(`server password ${password}`)
      return yield* options.mode === "service"
        ? server.shutdown
        : options.mode === "stdio"
          ? waitForStdinClose()
          : Effect.never
    }).pipe(Effect.annotateLogs({ role: "server" })),
  )
})

function serviceURL(hostname: string, port: number) {
  return `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`
}

function truthy(value?: string) {
  return value === "1" || value?.toLowerCase() === "true"
}

function addressInUse(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  if ("code" in error && error.code === "EADDRINUSE") return true
  return "cause" in error && addressInUse(error.cause)
}

// Why the bind failed against an owner the registration could not name: an opencode server
// (it frees the port itself, or becomes discoverable again), a port that was just freed (the
// bind may still win), or a foreign or silent owner that never will.
type PortOwnerProbe = "service" | "free" | "foreign"

// Ask the port's owner the way a client would, with the same request timeout the client's own
// discovery probes use (defaultEnsureTiming.requestTimeout). An answer in one of the shapes
// packages/server emits for /api/info identifies an opencode service; anything else, or no
// answer at all, does not.
async function probePortOwner(port: number, hostname: string, password?: string): Promise<PortOwnerProbe> {
  const headers =
    password === undefined
      ? undefined
      : { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") }
  try {
    const response = await fetch(new URL("/api/info", serviceURL(hostname, port)), {
      headers,
      signal: AbortSignal.timeout(2_000),
    })
    return opencodeHealth(await response.json().catch(() => undefined)) ? "service" : "foreign"
  } catch (cause) {
    return connectionRefused(cause) ? "free" : "foreign"
  }
}

// The JSON shapes packages/server answers /api/info with before the app router runs: the info
// body, the starting/stopping/failed body, and the unauthorized challenge.
function opencodeHealth(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false
  const record = body as { readonly pid?: unknown; readonly code?: unknown; readonly _tag?: unknown }
  if (Number.isInteger(record.pid) && (record.pid as number) >= 0) return true
  if (
    record.code === "service_starting" ||
    record.code === "service_stopping" ||
    record.code === "service_failed"
  )
    return true
  return record._tag === "UnauthorizedError"
}

// A refused connection means the owner exited between the failed bind and the probe; the bind
// may still win, so that race keeps its retry.
function connectionRefused(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false
  if ("code" in cause && cause.code === "ECONNREFUSED") return true
  return "cause" in cause && connectionRefused(cause.cause)
}

function portInUseMessage(port: number | undefined, hostname: string, owner: string | undefined) {
  return (
    `Managed service port ${port} on ${hostname} is already in use by ${owner ?? "another process"}. ` +
    "Configure another port with `opencode service set port <port>` and start the service again."
  )
}

function waitForStdinClose() {
  return Effect.callback<void>((resume) => {
    const close = () => resume(Effect.void)
    process.stdin.once("end", close)
    process.stdin.once("close", close)
    process.stdin.resume()
    if (process.stdin.readableEnded || process.stdin.destroyed) close()
    return Effect.sync(() => {
      process.stdin.off("end", close)
      process.stdin.off("close", close)
      process.stdin.pause()
    })
  })
}
