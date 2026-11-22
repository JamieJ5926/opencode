import { expect, test } from "bun:test"
import { registerCommaBindings } from "@opentui/keymap/addons/opentui"
import { createTestKeymap } from "@opentui/keymap/testing"
import { TuiKeybind } from "../src/config/keybind"

test("binds agent cycling only to shift+tab by default", () => {
  expect(TuiKeybind.Definitions["agent.cycle"].default).toBe("shift+tab")
  expect(TuiKeybind.Definitions["agent.cycle.reverse"].default).toBe("none")
})

const KEYPAD_COMMANDS = [
  "input.move.left",
  "input.move.right",
  "input.move.up",
  "input.move.down",
  "input.word.forward",
  "input.word.backward",
] as const

// Kitty keypad names decode to kpleft/kpright/kpup/kpdown in @opentui/core and must
// reach the same commands the arrows they mirror reach (issue #63947).
test("keypad arrows fire the input commands their mirrored arrows fire", () => {
  const keybinds = TuiKeybind.parse({})
  const config = { keybinds: createLookup(keybinds) }
  const fired: string[] = []
  const harness = createTestKeymap({ defaultKeys: true })
  const disposeComma = registerCommaBindings(harness.keymap)
  harness.keymap.registerLayer({
    commands: KEYPAD_COMMANDS.map((id) => ({
      name: id,
      run: () => {
        fired.push(id)
      },
    })),
    bindings: KEYPAD_COMMANDS.flatMap((id) => config.keybinds.get(id)),
  })
  harness.host.focus(harness.root)

  harness.host.press("kpleft")
  harness.host.press("kpleft", { ctrl: true })
  harness.host.press("kpright", { ctrl: true })
  harness.host.press("kpup")
  harness.host.press("kpdown")

  expect(fired).toEqual([
    "input.move.left",
    "input.word.backward",
    "input.word.forward",
    "input.move.up",
    "input.move.down",
  ])

  // The mirrored arrow keys keep firing the same commands.
  fired.length = 0
  harness.host.press("left", { ctrl: true })
  harness.host.press("left")
  expect(fired).toEqual(["input.word.backward", "input.move.left"])

  disposeComma()
  harness.cleanup()
})

function createLookup(keybinds: ReturnType<typeof TuiKeybind.parse>) {
  const byCommand = new Map(
    Object.entries(TuiKeybind.toBindingConfig(keybinds)).flatMap(([command, value]) =>
      typeof value === "string" ? [[command, [{ key: value, cmd: command }]] as const] : [],
    ),
  )
  return {
    get(command: string) {
      return byCommand.get(command) ?? []
    },
  }
}
