/**
 * @file displayWatcher.js
 * @description Keeps the site's catalog current after any change to what is
 * for sale (umina-achala-web#116): about once a minute it reads the display
 * topic's latest sequence number from the mirror node, and when a new LISTED
 * or UNLISTED has arrived it asks for a catalog rebuild. That covers a sale
 * on the site, a sale from the command line (sellOwnItem.js posts UNLISTED
 * too) and a listing changed by hand (displayEvent.js). The first check after
 * start asks for one rebuild, so the catalog is current from the start.
 */

import { mirrorNode } from "umina-achala-chain/network";

/** The display topic's latest sequence number, or 0 when it has no messages. */
export async function latestSequence(topicId, fetchFn = fetch) {
  const response = await fetchFn(`${mirrorNode()}/api/v1/topics/${topicId}/messages?order=desc&limit=1`);
  if (!response.ok) throw new Error(`mirror node request failed: ${response.status}`);
  const body = await response.json();
  return body.messages?.[0]?.sequence_number ?? 0;
}

/**
 * @param {object} options
 * @param {string} options.topicId HCS_DISPLAY_TOPIC_ID
 * @param {{ request: () => unknown }} options.catalog the rebuild queue
 * @param {number} [options.everyMs] how often to look
 * @param {{ latest?: (topicId: string) => Promise<number>, log?: { log: Function, error: Function } }} [options.deps]
 */
export function createDisplayWatcher({ topicId, catalog, everyMs = 60_000, deps = {} }) {
  const latest = deps.latest ?? ((id) => latestSequence(id));
  const log = deps.log ?? console;
  let seen = null;
  let timer = null;

  /** One look: asks for a rebuild when the sequence number moved (or on the first look). */
  async function check() {
    try {
      const seq = await latest(topicId);
      if (seen === null || seq !== seen) {
        if (seen !== null) log.log(`display topic at #${seq} (was #${seen}): rebuilding the catalog`);
        seen = seq;
        catalog.request();
      }
    } catch (err) {
      log.error(`display topic check failed: ${err.message}`);
    }
  }

  return {
    check,
    start() {
      check();
      timer = setInterval(check, everyMs);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
    },
  };
}
