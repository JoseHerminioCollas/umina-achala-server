import { PrivateKey } from "umina-achala-chain/sdk";
import { topicKeyProblems } from "../src/topicKeys.js";

// The start check on the topics' submit keys (umina-achala-web#139), with the
// mirror node's topic reply faked.

const PROVENANCE = "0.0.3003";
const DISPLAY = "0.0.3004";
const operatorKey = PrivateKey.generateECDSA();
const submitKey = PrivateKey.generateECDSA();
const otherKey = PrivateKey.generateECDSA();

const keyOf = (key) => ({ _type: "ECDSA_SECP256K1", key: key.publicKey.toStringRaw() });
const env = {
  OPERATOR_KEY: operatorKey.toStringDer(),
  HCS_SUBMIT_KEY: submitKey.toStringDer(),
  HCS_TOPIC_ID: PROVENANCE,
  HCS_DISPLAY_TOPIC_ID: DISPLAY,
};

/** readTopic for both topics: a topic object, null (unknown), or an Error to throw. */
const topics = (provenance, display = provenance) => async (id) => {
  const reply = id === PROVENANCE ? provenance : display;
  if (reply instanceof Error) throw reply;
  return reply;
};

describe("topicKeyProblems", () => {
  test("passes when HCS_SUBMIT_KEY is both topics' submit key", async () => {
    const result = await topicKeyProblems(env, { readTopic: topics({ deleted: false, submit_key: keyOf(submitKey) }) });
    expect(result).toEqual({ problems: [], warnings: [] });
  });

  test("passes when the operator key is the submit key, or a topic has none", async () => {
    const { HCS_SUBMIT_KEY, ...noSubmitKey } = env;
    const result = await topicKeyProblems(noSubmitKey, {
      readTopic: topics({ deleted: false, submit_key: keyOf(operatorKey) }, { deleted: false, submit_key: null }),
    });
    expect(result).toEqual({ problems: [], warnings: [] });
  });

  test("refuses when a topic has a submit key and HCS_SUBMIT_KEY is not set (the launch bug)", async () => {
    const { HCS_SUBMIT_KEY, ...noSubmitKey } = env;
    const { problems } = await topicKeyProblems(noSubmitKey, {
      readTopic: topics({ deleted: false, submit_key: keyOf(submitKey) }),
    });
    expect(problems).toEqual([
      `the provenance topic ${PROVENANCE} has a submit key and HCS_SUBMIT_KEY is not set; messages would fail with INVALID_SIGNATURE`,
      `the display topic ${DISPLAY} has a submit key and HCS_SUBMIT_KEY is not set; messages would fail with INVALID_SIGNATURE`,
    ]);
  });

  test("refuses when HCS_SUBMIT_KEY is another key", async () => {
    const { problems } = await topicKeyProblems(env, {
      readTopic: topics({ deleted: false, submit_key: keyOf(submitKey) }, { deleted: false, submit_key: keyOf(otherKey) }),
    });
    expect(problems).toEqual([`HCS_SUBMIT_KEY is not the submit key of the display topic ${DISPLAY}; messages would fail with INVALID_SIGNATURE`]);
  });

  test("refuses a topic the mirror node does not know, or a deleted one", async () => {
    const { problems } = await topicKeyProblems(env, { readTopic: topics(null, { deleted: true, submit_key: null }) });
    expect(problems).toEqual([
      `the provenance topic ${PROVENANCE} (HCS_TOPIC_ID) is not on the mirror node; check the ID, or whether testnet was reset`,
      `the display topic ${DISPLAY} (HCS_DISPLAY_TOPIC_ID) is deleted`,
    ]);
  });

  test("only warns when the mirror node does not answer, or the key is a key list", async () => {
    const result = await topicKeyProblems(env, {
      readTopic: topics(new Error("mirror node request failed: 503"), { deleted: false, submit_key: { _type: "ProtobufEncoded", key: "0a" } }),
    });
    expect(result.problems).toEqual([]);
    expect(result.warnings).toEqual([
      `could not check the provenance topic ${PROVENANCE} on the mirror node (mirror node request failed: 503); starting anyway`,
      `the display topic ${DISPLAY} has a ProtobufEncoded submit key, which cannot be checked here; starting anyway`,
    ]);
  });

  test("a malformed key is a problem, not a crash", async () => {
    const { problems } = await topicKeyProblems({ ...env, OPERATOR_KEY: "not-a-key" }, { readTopic: topics(null) });
    expect(problems).toEqual(["OPERATOR_KEY is not an ECDSA private key (hex or DER)"]);
  });
});
