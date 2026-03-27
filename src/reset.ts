/**
 * Reset — deletes all generated wallets and agents.json.
 * Use this to start completely fresh.
 *
 * ⚠️  Any funds on the agent wallets will be inaccessible unless you have backups.
 *
 * Usage:
 *   npm run reset
 */
import * as fs from "fs";
import * as path from "path";

const ROOT        = path.resolve(__dirname, "..");
const GL_PEM      = path.join(ROOT, "gl.pem");
const WALLETS_DIR = path.join(ROOT, "wallets");
const AGENTS_FILE = path.join(ROOT, "agents.json");

console.log("╔══════════════════════════════════════════╗");
console.log("║  Agent Arena — Reset                     ║");
console.log("╚══════════════════════════════════════════╝\n");

let removed = 0;

if (fs.existsSync(WALLETS_DIR)) {
  fs.rmSync(WALLETS_DIR, { recursive: true });
  console.log("🗑  wallets/ removed");
  removed++;
}

if (fs.existsSync(AGENTS_FILE)) {
  fs.rmSync(AGENTS_FILE);
  console.log("🗑  agents.json removed");
  removed++;
}

if (fs.existsSync(GL_PEM)) {
  fs.rmSync(GL_PEM);
  console.log("🗑  gl.pem removed");
  removed++;
}

if (removed === 0) {
  console.log("Nothing to remove — already clean.");
} else {
  console.log("\n✅ Reset complete. Run `npm run setup` to generate fresh wallets.");
}
