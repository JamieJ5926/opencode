import { writeFileSync } from "node:fs"

// Stands in for the node server behind an `npm exec` wrapper: it never exits on stdin EOF, the
// shape that turns a killed opencode server into an orphaned wrapper-plus-server pair.
const [pidFile] = process.argv.slice(2)
writeFileSync(pidFile, String(process.pid))
process.stdin.resume()
process.on("SIGTERM", () => process.exit(0))
setInterval(() => {}, 1 << 30)
