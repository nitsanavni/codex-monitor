import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn("sleep", ["60"], { detached: true, stdio: "inherit" });
writeFileSync(process.argv[2], String(child.pid));
child.unref();
