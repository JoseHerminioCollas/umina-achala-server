/**
 * @file server.js
 * @description Starts the sale backend (umina-achala-web#116): checks the
 * environment, then serves the app on 127.0.0.1 and watches the display topic
 * to keep the catalog current. Run through saleServer.js.
 */

import { existsSync } from "fs";
import { envProblems } from "umina-achala-chain/env";
import { submitKeyProblem } from "umina-achala-chain/hcs";
import { treasuryKeyProblem } from "umina-achala-chain/keys";
import { envFileProblem, networkName, networkProblem } from "umina-achala-chain/network";
import { connect, loadEnv } from "umina-achala-chain/script";
import { createApp } from "./app.js";
import { createCatalogQueue } from "./catalogQueue.js";
import { createDisplayWatcher } from "./displayWatcher.js";
import { createSaleService } from "./saleService.js";

export const SERVER_ENV = [
  "OPERATOR_ID",
  "OPERATOR_KEY",
  "TREASURY_ID",
  "UMINA_TOKEN_ID",
  "ACHALA_TOKEN_ID",
  "HCS_TOPIC_ID",
  "HCS_DISPLAY_TOPIC_ID",
  "CATALOG_DIR",
];

/** The problems that stop the server from starting, or []. */
export function serverProblems(env) {
  const network = networkProblem(env);
  if (network) return [network];
  if (networkName(env) !== "testnet") return [`the sale backend runs on testnet only in Phase 2B, got NETWORK=${networkName(env)}`];
  const problems = envProblems(env, SERVER_ENV);
  for (const p of [treasuryKeyProblem(env), submitKeyProblem(env)]) if (p) problems.push(p);
  if (env.CATALOG_DIR && !existsSync(env.CATALOG_DIR)) problems.push(`CATALOG_DIR ${env.CATALOG_DIR} does not exist`);
  if (env.PORT && !/^\d{2,5}$/.test(env.PORT)) problems.push("PORT must be a port number");
  return problems;
}

/** Starts the server; returns it, or null when the environment is not usable. */
export function start(env = process.env) {
  const fileProblem =
    env.ENV_FILE && !networkProblem(env)
      ? envFileProblem(env.ENV_FILE, env) ?? (existsSync(env.ENV_FILE) ? null : `ENV_FILE ${env.ENV_FILE} does not exist`)
      : null;
  if (env.ENV_FILE && !fileProblem) loadEnv(env.ENV_FILE);
  const problems = fileProblem ? [fileProblem] : serverProblems(env);
  if (problems.length) {
    console.error("❌ The sale backend cannot start:");
    problems.forEach((p) => console.error(`   - ${p}`));
    process.exitCode = 1;
    return null;
  }
  const client = connect(env);
  const catalog = createCatalogQueue(env.CATALOG_DIR);
  const sales = createSaleService({ client, env, catalog });
  const app = createApp({ sales, catalog, network: networkName(env) });
  const watcher = createDisplayWatcher({ topicId: env.HCS_DISPLAY_TOPIC_ID, catalog });
  watcher.start();
  const port = Number(env.PORT ?? 8787);
  const server = app.listen(port, "127.0.0.1", () => {
    console.log(`Sale backend on 127.0.0.1:${port} (${networkName(env)}), catalog in ${env.CATALOG_DIR}`);
  });
  const stop = () => (watcher.stop(), server.close(() => (client.close(), process.exit(0))));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return server;
}

