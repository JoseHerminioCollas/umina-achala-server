/**
 * @file catalogQueue.js
 * @description Reruns umina-achala-chain's catalog builder
 * (buildCatalog.js, umina-achala-chain#44) after a sale or a listing change,
 * one run at a time
 * (umina-achala-web#116). A request made while a run is going is kept, and
 * one more run starts after it, however many requests came in meanwhile. The
 * builder writes catalog.json to a temp file and renames it, so the site never
 * reads half a file.
 */

import { spawn } from "child_process";
import { createRequire } from "module";
import { join } from "path";

// The builder in umina-achala-chain, from this package's folder (pm2's cwd)
const BUILDER = createRequire(join(process.cwd(), "package.json")).resolve("umina-achala-chain/catalog/buildCatalog.js");

/** Runs the builder once into outDir; resolves with its exit code. */
export function runBuilder(outDir, { env = process.env, log = console } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BUILDER, outDir], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (b) => (output += b));
    child.stderr.on("data", (b) => (output += b));
    child.on("error", (err) => {
      log.error(`catalog build could not start: ${err.message}`);
      resolve(1);
    });
    child.on("close", (code) => {
      const last = output.trim().split("\n").slice(-3).join(" | ");
      (code === 0 ? log.log : log.error)(`catalog build ${code === 0 ? "done" : `failed (${code})`}: ${last}`);
      resolve(code ?? 1);
    });
  });
}

/**
 * @param {string} outDir the site's data folder (CATALOG_DIR)
 * @param {{ run?: (outDir: string) => Promise<number>, now?: () => number }} [options]
 */
export function createCatalogQueue(outDir, { run = (dir) => runBuilder(dir), now = () => Date.now() } = {}) {
  let running = null;
  let again = false;
  let lastBuilt = null;
  let lastCode = null;

  async function loop() {
    do {
      again = false;
      lastCode = await run(outDir);
      if (lastCode === 0) lastBuilt = new Date(now()).toISOString();
    } while (again);
    running = null;
  }

  return {
    /** Asks for a rebuild; returns a promise that settles when the builds now due are done. */
    request() {
      if (running) {
        again = true;
        return running;
      }
      running = loop();
      return running;
    },
    status: () => ({ running: Boolean(running), lastBuilt, lastCode }),
  };
}
