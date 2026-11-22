import { Effect } from "effect"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { McpStdio } from "@opencode/core/mcp/stdio"
import { writeFileSync } from "node:fs"
import { hostEnvironmentLayer } from "../environment"
import { location } from "../location"

// Stands in for the opencode server: starts a local stdio MCP transport through a wrapper, writes
// the direct child's pid, then stays alive until the test kills it (SIGKILL) or asks for a graceful
// close (SIGUSR2).
const [pidsFile, command, ...args] = process.argv.slice(2)

const ref = Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })

const program = Effect.scoped(
  Effect.gen(function* () {
    const transport = yield* McpStdio.make({
      server: "process-guard",
      command,
      args,
      cwd: process.cwd(),
      environment: {},
    })
    yield* Effect.promise(() => transport.start())
    writeFileSync(pidsFile, JSON.stringify({ wrapper: transport.pid }))
    process.on("SIGUSR2", () => {
      void transport.close().then(
        () => process.exit(0),
        () => process.exit(1),
      )
    })
    yield* Effect.never
  }),
)

await Effect.runPromise(
  program.pipe(
    Effect.provide(hostEnvironmentLayer),
    Effect.provideService(Location.Service, Location.Service.of(location(ref))),
  ),
)
