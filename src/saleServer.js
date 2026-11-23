/**
 * @file saleServer.js
 * @description Starts the sale backend (umina-achala-web#116): a Node service
 * run by pm2 on the server (ecosystem.config.cjs), listening on 127.0.0.1
 * only, behind Nginx's /api/.
 *
 *   NETWORK=testnet ENV_FILE=/path/to/umina-achala.testnet.env node src/saleServer.js
 *
 * The env file (outside the repo, chmod 600) holds UA's keys: OPERATOR_ID and
 * OPERATOR_KEY (UA, who pays and receives), TREASURY_ID (and TREASURY_KEY when
 * it is its own account), the tokens and topics (HCS_SUBMIT_KEY if the topics
 * have one), and CATALOG_DIR, the site's data folder the catalog is rebuilt
 * into. PORT is optional (8787). Keys are never logged.
 *
 * Phase 2B is testnet only: it refuses to start on any other network.
 */

import { start } from "./server.js";

start();
