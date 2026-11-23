import { jest } from "@jest/globals";
import { createDisplayWatcher, latestSequence } from "../src/displayWatcher.js";

// The display topic watcher (umina-achala-web#116): a rebuild on start, and
// after any new LISTED or UNLISTED, wherever it came from.

const log = { log: jest.fn(), error: jest.fn() };

test("asks for a rebuild on the first look, then only when the topic moved", async () => {
  const seqs = [5, 5, 6, 6, 9];
  const catalog = { request: jest.fn() };
  const watcher = createDisplayWatcher({ topicId: "0.0.3004", catalog, deps: { latest: async () => seqs.shift(), log } });
  for (let i = 0; i < 5; i++) await watcher.check();
  expect(catalog.request).toHaveBeenCalledTimes(3); // #5 at start, #6, #9
  expect(log.log).toHaveBeenCalledWith("display topic at #9 (was #6): rebuilding the catalog");
});

test("a mirror node failure is logged and the next look tries again", async () => {
  const catalog = { request: jest.fn() };
  const latest = jest.fn().mockRejectedValueOnce(new Error("503")).mockResolvedValue(3);
  const watcher = createDisplayWatcher({ topicId: "0.0.3004", catalog, deps: { latest, log } });
  await watcher.check();
  expect(catalog.request).not.toHaveBeenCalled();
  expect(log.error).toHaveBeenCalledWith("display topic check failed: 503");
  await watcher.check();
  expect(catalog.request).toHaveBeenCalledTimes(1);
});

test("latestSequence reads the newest message's sequence number from the mirror node", async () => {
  const fetchFn = jest.fn(async () => ({ ok: true, json: async () => ({ messages: [{ sequence_number: 42 }] }) }));
  expect(await latestSequence("0.0.3004", fetchFn)).toBe(42);
  expect(fetchFn).toHaveBeenCalledWith("https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.3004/messages?order=desc&limit=1");
  const empty = jest.fn(async () => ({ ok: true, json: async () => ({ messages: [] }) }));
  expect(await latestSequence("0.0.3004", empty)).toBe(0);
  const down = jest.fn(async () => ({ ok: false, status: 500 }));
  await expect(latestSequence("0.0.3004", down)).rejects.toThrow("500");
});
