import { spawn } from "node:child_process"

// Mimics an `npm exec` wrapper: a process that launches the real server as a child and waits for
// it, so killing only the direct child leaves the server behind.
const [stub, pidFile] = process.argv.slice(2)
const child = spawn(process.execPath, [stub, pidFile], { stdio: "inherit" })
child.on("exit", (code) => process.exit(code ?? 1))
