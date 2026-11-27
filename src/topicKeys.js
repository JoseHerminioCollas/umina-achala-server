/**
 * @file topicKeys.js
 * @description Checks at start that the backend can post to both topics
 * (umina-achala-web#139): a topic with a submit key accepts a message only
 * when it is signed with that key. The backend signs with the operator key
 * (it pays) and with HCS_SUBMIT_KEY when set, so one of the two must be the
 * topic's submit key. Without this check, a missing HCS_SUBMIT_KEY showed only
 * after a sale had settled, when its SALE and UNLISTED failed with
 * INVALID_SIGNATURE.
 */

import { parseEcdsaKey } from "umina-achala-chain/keys";
import { topicInfo } from "umina-achala-chain/mirror";

const TOPICS = [
  ["HCS_TOPIC_ID", "provenance topic"],
  ["HCS_DISPLAY_TOPIC_ID", "display topic"],
];

/** Single-key types the mirror node gives as hex in `key`. */
const SINGLE_KEY_TYPES = ["ECDSA_SECP256K1", "ED25519"];

/**
 * The problems that stop the backend from starting, and warnings that do not.
 * A topic unknown to the mirror node (deleted, or testnet reset) is a
 * problem; the mirror node not answering is only a warning, so a short outage
 * after a reboot does not keep the site's sales down.
 * @param {Record<string, string | undefined>} env OPERATOR_KEY, HCS_SUBMIT_KEY, the topic IDs
 * @param {{ readTopic?: typeof topicInfo }} [deps]
 * @returns {Promise<{ problems: string[], warnings: string[] }>}
 */
export async function topicKeyProblems(env, { readTopic = topicInfo } = {}) {
  const problems = [];
  const warnings = [];
  const signers = [];
  for (const name of ["OPERATOR_KEY", "HCS_SUBMIT_KEY"]) {
    if (!env[name]) continue;
    try {
      signers.push(parseEcdsaKey(env[name]).publicKey.toStringRaw().toLowerCase());
    } catch {
      return { problems: [`${name} is not an ECDSA private key (hex or DER)`], warnings };
    }
  }

  for (const [name, label] of TOPICS) {
    const topicId = env[name];
    let topic;
    try {
      topic = await readTopic(topicId);
    } catch (err) {
      warnings.push(`could not check the ${label} ${topicId} on the mirror node (${err.message}); starting anyway`);
      continue;
    }
    if (!topic) {
      problems.push(`the ${label} ${topicId} (${name}) is not on the mirror node; check the ID, or whether testnet was reset`);
      continue;
    }
    if (topic.deleted) {
      problems.push(`the ${label} ${topicId} (${name}) is deleted`);
      continue;
    }
    const submitKey = topic.submit_key;
    if (!submitKey) continue; // anyone may post
    if (!SINGLE_KEY_TYPES.includes(submitKey._type)) {
      warnings.push(`the ${label} ${topicId} has a ${submitKey._type} submit key, which cannot be checked here; starting anyway`);
      continue;
    }
    if (signers.includes(String(submitKey.key).toLowerCase())) continue;
    problems.push(
      env.HCS_SUBMIT_KEY
        ? `HCS_SUBMIT_KEY is not the submit key of the ${label} ${topicId}; messages would fail with INVALID_SIGNATURE`
        : `the ${label} ${topicId} has a submit key and HCS_SUBMIT_KEY is not set; messages would fail with INVALID_SIGNATURE`,
    );
  }
  return { problems, warnings };
}
