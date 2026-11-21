import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { ConfigDiscovery } from "@opencode/core/config/discovery"
import { ConfigWatch } from "@opencode/core/config/watch"
import { Location } from "@opencode/core/location"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { AbsolutePath } from "@opencode/core/schema"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

const project = path.resolve("watch-plan-project")
const root = AbsolutePath.make(path.join(project, ".opencode"))
const sources: ConfigDiscovery.Sources = {
  direct: ["opencode.json", "opencode.jsonc"].map((name) => AbsolutePath.make(path.join(project, name))),
  project: [{ path: root, present: false }],
  claude: [AbsolutePath.make(path.join(project, ".claude"))],
  agents: [AbsolutePath.make(path.join(project, ".agents"))],
}

describe("ConfigWatch.plan", () => {
  test("groups missing candidates and keeps parent watches when roots appear", () => {
    const missing = ConfigWatch.plan(sources)
    expect(Array.from(missing.values())).toEqual([
      { path: project, type: "entries", names: [".agents", ".claude", ".opencode", "opencode.json", "opencode.jsonc"] },
    ])
    const system = AbsolutePath.make(path.join(project, "system-opencode"))
    const present = ConfigWatch.plan({
      ...sources,
      system: { path: system, present: true },
      project: [{ path: root, present: true }],
    })
    expect(Array.from(present.values())).toEqual([
      { path: system, type: "directory", ignore: FSUtil.ignoreGlobs },
      { path: root, type: "directory", ignore: FSUtil.ignoreGlobs },
      {
        path: project,
        type: "entries",
        names: [".agents", ".claude", ".opencode", "opencode.json", "opencode.jsonc", "system-opencode"],
      },
    ])
  })

  test("adds exact watches for explicit files only when not already covered", () => {
    expect(ConfigWatch.plan({ ...sources, explicit: sources.direct[0] })).toEqual(ConfigWatch.plan(sources))
    const present = { ...sources, project: [{ path: root, present: true }] }
    expect(ConfigWatch.plan({ ...present, explicit: AbsolutePath.make(path.join(root, "custom.json")) })).toEqual(
      ConfigWatch.plan(present),
    )
    const directory = path.resolve("watch-plan-external")
    expect(
      Array.from(
        ConfigWatch.plan({ ...sources, explicit: AbsolutePath.make(path.join(directory, "custom.json")) }).values(),
      ),
    ).toContainEqual({ path: directory, type: "entries", names: ["custom.json"] })
  })

  function discoverAt(root: string, directory: string) {
    return ConfigDiscovery.discover({ system: false }).pipe(
      Effect.provide(
        Layer.mergeAll(
          AppNodeBuilder.build(FSUtil.node),
          Global.layerWith({ config: path.join(root, "global"), home: path.join(root, "global", "home") }),
          Layer.succeed(
            Location.Service,
            Location.Service.of(
              location(
                { directory: AbsolutePath.make(directory) },
                { projectDirectory: AbsolutePath.make(directory) },
              ),
            ),
          ),
        ),
      ),
    )
  }

  it.live("does not plan watchers above the project root for a deep location", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const root = yield* Effect.promise(() => fs.realpath(tmp.path))
          const repo = path.join(root, "repo")
          const deep = path.join(repo, "packages", "feature", "src", "deep")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(repo, ".git"), { recursive: true })
            await fs.mkdir(deep, { recursive: true })
          })
          const sources = yield* discoverAt(root, deep)
          const targets = Array.from(ConfigWatch.plan(sources).values())
          const outside = targets.filter(
            (target) => target.path !== repo && !target.path.startsWith(repo + path.sep),
          )
          // The global config directory is watched from outside the repo.
          expect(outside.map((target) => target.path)).toContainEqual(path.join(root, "global"))
          // Above the repo only config that exists today may be watched: the walk to "/" used to
          // plan an entries watch on every ancestor from candidates that do not exist.
          for (const target of outside) {
            if (target.type !== "entries") continue
            for (const name of target.names) {
              expect(
                yield* Effect.promise(() =>
                  fs
                    .stat(path.join(target.path, name))
                    .then(
                      () => true,
                      () => false,
                    ),
                ),
              ).toBe(true)
            }
          }
          expect(targets).toContainEqual({
            path: deep,
            type: "entries",
            names: [".agents", ".claude", ".opencode", "opencode.json", "opencode.jsonc"],
          })
          expect(targets).toContainEqual({
            path: repo,
            type: "entries",
            names: [".agents", ".claude", ".opencode", "opencode.json", "opencode.jsonc"],
          })
        }),
      ),
    ),
  )
})
