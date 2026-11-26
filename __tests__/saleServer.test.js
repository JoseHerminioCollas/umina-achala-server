import { jest } from "@jest/globals";
import { Client, PrivateKey, Transaction, TransferTransaction } from "umina-achala-chain/sdk";
import { createApp, rateLimit } from "../src/app.js";
import { createCatalogQueue } from "../src/catalogQueue.js";
import { checkPrepareInput, createSaleService, publicKeyOf, VALID_SECONDS } from "../src/saleService.js";
import { serverProblems } from "../src/server.js";

// The sale backend (umina-achala-web#116): the service and its HTTP side, with
// the mirror node, the topics and Hedera's execute mocked. Transactions are
// real SDK transactions, frozen and signed, so the signature checks are real.

const UMINA = "0.0.2002";
const ACHALA = "0.0.2003";
const OPERATOR = "0.0.1001";
const TREASURY = "0.0.1002";
const BUYER = "0.0.6006";
const operatorKey = PrivateKey.generateECDSA();
const treasuryKey = PrivateKey.generateECDSA();
const buyerKey = PrivateKey.generateED25519();
const otherKey = PrivateKey.generateED25519();

const env = {
  NETWORK: "testnet",
  OPERATOR_ID: OPERATOR,
  OPERATOR_KEY: operatorKey.toStringRaw(),
  TREASURY_ID: TREASURY,
  TREASURY_KEY: treasuryKey.toStringRaw(),
  UMINA_TOKEN_ID: UMINA,
  ACHALA_TOKEN_ID: ACHALA,
  HCS_TOPIC_ID: "0.0.3003",
  HCS_DISPLAY_TOPIC_ID: "0.0.3004",
  CATALOG_DIR: ".",
};

const ev = (seq, event, ts = `${seq}.0`) => ({ sequence_number: seq, consensus_timestamp: ts, event });
const mint = (tokenId, serial, stoneId, extra = {}) => ({ event: "MINT", token_id: tokenId, serials: [String(serial)], stone_id: stoneId, ...extra });
const listed = (tokenId, serial, price) => ({ event: "LISTED", token_id: tokenId, serials: [String(serial)], price, currency: "HBAR" });
const unlisted = (tokenId, serial) => ({ event: "UNLISTED", token_id: tokenId, serials: [String(serial)], reason: "sold" });

const provenanceEvents = [
  ev(1, mint(UMINA, 15, "UMINA-2026-AG-01")),
  ev(2, mint(UMINA, 19, "UMINA-2026-AU-01")),
  ev(3, mint(ACHALA, 6, "ACHALA-2026-PE-02", { from_stone_ids: ["UMINA-2026-AU-01"] })),
  ev(4, mint(UMINA, 16, "UMINA-2026-CH-99")),
];

function setup({ display = [ev(10, listed(UMINA, 15, "45")), ev(11, listed(ACHALA, 6, "120"))], holders, account } = {}) {
  const state = { display: [...display], now: 1_000_000, submitted: [], logs: [] };
  const deps = {
    readProvenance: jest.fn(async () => ({ events: provenanceEvents })),
    readDisplay: jest.fn(async () => ({ events: state.display })),
    latestArrival: jest.fn(async () => "5.0"),
    holders: jest.fn(async (ids) => ids.map(() => holders ?? { account_id: TREASURY, deleted: false })),
    buyerAccount: jest.fn(async () => account ?? { key: { _type: "ED25519", key: buyerKey.publicKey.toStringRaw() }, notAssociated: [] }),
    submitEvent: jest.fn(async (client, topicId, message) => {
      state.submitted.push({ topicId, message });
      // the display topic shows the UNLISTED at once
      if (topicId === env.HCS_DISPLAY_TOPIC_ID) state.display.push(ev(100 + state.submitted.length, message));
      return "0.0.1001@1.1";
    }),
    now: () => state.now,
    sleep: async () => {},
    log: { log: (...a) => state.logs.push(a.join(" ")), error: (...a) => state.logs.push(a.join(" ")) },
  };
  const client = Client.forTestnet().setOperator(OPERATOR, operatorKey);
  clients.push(client);
  const catalog = { request: jest.fn(), status: () => ({ running: false, lastBuilt: null }) };
  const sales = createSaleService({ client, env, catalog, deps });
  return { sales, deps, state, client, catalog };
}

/** The buyer's wallet: signs the prepared transaction and returns it in base64. */
async function walletSign(base64, key = buyerKey) {
  const tx = Transaction.fromBytes(Buffer.from(base64, "base64"));
  return Buffer.from((await tx.sign(key)).toBytes()).toString("base64");
}

// every client a test opens is closed after it, even when the test fails
const clients = [];
afterEach(() => clients.splice(0).forEach((c) => c.close()));

let execute;
beforeEach(() => {
  execute = jest.spyOn(TransferTransaction.prototype, "execute").mockImplementation(async function () {
    return {
      transactionId: this.transactionId,
      getReceipt: async () => ({ status: { toString: () => "SUCCESS" } }),
    };
  });
});
afterEach(() => jest.restoreAllMocks());

describe("prepare", () => {
  test("builds the listed item's sale at the listed price, signed by UA and the Treasury, for one node", async () => {
    const { sales, client } = setup();
    const out = await sales.prepare({ token: "umina", serial: 15, buyer: BUYER });
    expect(out).toMatchObject({ stoneId: "UMINA-2026-AG-01", price: { amount: "45", currency: "HBAR" }, nfts: [`${UMINA}/15`] });
    const tx = Transaction.fromBytes(Buffer.from(out.transaction, "base64"));
    expect(tx.transactionId.accountId.toString()).toBe(OPERATOR); // UA pays the fee
    expect(tx.nodeAccountIds).toHaveLength(1);
    expect(tx.transactionValidDuration).toBe(VALID_SECONDS);
    const hbar = Object.fromEntries([...tx.hbarTransfers].map(([id, h]) => [id.toString(), h.toTinybars().toString()]));
    expect(hbar).toEqual({ [BUYER]: "-4500000000", [OPERATOR]: "4500000000" });
    const nft = [...tx.nftTransfers.get(UMINA)].map((t) => [t.serial.toString(), t.sender.toString(), t.recipient.toString()]);
    expect(nft).toEqual([["15", TREASURY, BUYER]]);
    expect(operatorKey.publicKey.verifyTransaction(tx)).toBe(true);
    expect(treasuryKey.publicKey.verifyTransaction(tx)).toBe(true);
    client.close();
  });

  test("an Achala moves with its mounted stones", async () => {
    const { sales, client } = setup();
    const out = await sales.prepare({ token: "achala", serial: "6", buyer: BUYER });
    expect(out.nfts).toEqual([`${ACHALA}/6`, `${UMINA}/19`]);
    expect(out.price.amount).toBe("120");
    client.close();
  });

  test("refuses an item that is not listed, unlisted, or listed before it last came back", async () => {
    const { sales, client, deps } = setup({ display: [ev(10, listed(UMINA, 15, "45")), ev(12, unlisted(UMINA, 15))] });
    await expect(sales.prepare({ token: "umina", serial: 15, buyer: BUYER })).rejects.toMatchObject({ code: "not_listed" });
    await expect(sales.prepare({ token: "umina", serial: 16, buyer: BUYER })).rejects.toMatchObject({ code: "not_listed" });
    await expect(sales.prepare({ token: "umina", serial: 99, buyer: BUYER })).rejects.toMatchObject({ code: "not_listed" });
    deps.latestArrival.mockResolvedValue("20.0"); // came back after the LISTED
    await expect(sales.prepare({ token: "achala", serial: 6, buyer: BUYER })).rejects.toMatchObject({ code: "not_listed" });
    client.close();
  });

  test("refuses an item the Treasury no longer holds, and a stone mounted in an Achala", async () => {
    const { sales, client } = setup({ holders: { account_id: BUYER, deleted: false } });
    await expect(sales.prepare({ token: "umina", serial: 15, buyer: BUYER })).rejects.toMatchObject({ code: "not_available" });
    client.close();
    const mounted = setup({ display: [ev(10, listed(UMINA, 19, "30"))] });
    await expect(mounted.sales.prepare({ token: "umina", serial: 19, buyer: BUYER })).rejects.toMatchObject({
      code: "not_available",
      details: { problems: [expect.stringMatching(/ACHALA-2026-PE-02/)] },
    });
    mounted.client.close();
  });

  test("a buyer not associated with a token is told which, so the site can offer to associate", async () => {
    const { sales, client } = setup({ account: { key: { _type: "ED25519", key: buyerKey.publicKey.toStringRaw() }, notAssociated: [UMINA] } });
    const err = await sales.prepare({ token: "umina", serial: 15, buyer: BUYER }).catch((e) => e);
    expect(err).toMatchObject({ code: "not_associated", details: { tokens: [UMINA] } });
    client.close();
  });

  test("refuses a missing account, a key list, and UA's own accounts as buyer", async () => {
    const { sales, client, deps } = setup();
    deps.buyerAccount.mockResolvedValueOnce(null);
    await expect(sales.prepare({ token: "umina", serial: 15, buyer: BUYER })).rejects.toMatchObject({ code: "bad_request" });
    deps.buyerAccount.mockResolvedValueOnce({ key: { _type: "ProtobufEncoded", key: "abcd" }, notAssociated: [] });
    await expect(sales.prepare({ token: "umina", serial: 15, buyer: BUYER })).rejects.toMatchObject({ code: "unsupported_account" });
    await expect(sales.prepare({ token: "umina", serial: 15, buyer: TREASURY })).rejects.toMatchObject({ code: "bad_request" });
    client.close();
  });

  test("checks the input's shape before reading anything", () => {
    expect(() => checkPrepareInput({ token: "gold", serial: 1, buyer: BUYER })).toThrow(/token/);
    expect(() => checkPrepareInput({ token: "umina", serial: "1; drop", buyer: BUYER })).toThrow(/serial/);
    expect(() => checkPrepareInput({ token: "umina", serial: 0, buyer: BUYER })).toThrow(/serial/);
    expect(() => checkPrepareInput({ token: "umina", serial: 1, buyer: "alice" })).toThrow(/buyer/);
    expect(checkPrepareInput({ token: "umina", serial: 7, buyer: BUYER })).toEqual({ tokenClass: "umina", serial: "7", buyer: BUYER });
  });

  test("one pending sale per item; it unlocks when the sale expires", async () => {
    const { sales, state, client } = setup();
    await sales.prepare({ token: "umina", serial: 15, buyer: BUYER });
    state.now += 30_000;
    // another buyer is told it is being bought, and for how long, not that it is gone
    await expect(sales.prepare({ token: "umina", serial: 15, buyer: "0.0.7007" })).rejects.toMatchObject({
      code: "being_bought",
      details: { retryAfter: VALID_SECONDS - 30 },
    });
    // the pendant's gold is not the agate: another item is not locked
    await sales.prepare({ token: "achala", serial: 6, buyer: "0.0.7007" });
    expect(sales.pendingCount()).toBe(2);
    state.now += VALID_SECONDS * 1000 + 1;
    expect(sales.pendingCount()).toBe(0);
    await sales.prepare({ token: "umina", serial: 15, buyer: "0.0.7007" });
    client.close();
  });

  test("the same buyer starting again replaces their own pending sale", async () => {
    const { sales, state, client } = setup();
    const first = await sales.prepare({ token: "umina", serial: 15, buyer: BUYER });
    const second = await sales.prepare({ token: "umina", serial: 15, buyer: BUYER });
    expect(second.saleId).not.toBe(first.saleId);
    expect(sales.pendingCount()).toBe(1);
    // the first one can no longer be submitted, and the item stays held for this buyer
    await expect(sales.submit({ saleId: first.saleId, transaction: await walletSign(first.transaction) })).rejects.toMatchObject({ code: "replaced" });
    await expect(sales.prepare({ token: "umina", serial: 15, buyer: "0.0.7007" })).rejects.toMatchObject({ code: "being_bought" });
    // once its time would have run out, the replaced sale is just expired
    state.now += VALID_SECONDS * 1000 + 1;
    await expect(sales.submit({ saleId: first.saleId, transaction: await walletSign(first.transaction) })).rejects.toMatchObject({ code: "expired" });
    client.close();
  });

  test("a just-sold item is not available, not being bought, while the mirror node still lists it", async () => {
    const { sales, client, deps } = setup();
    const sale = await sales.prepare({ token: "umina", serial: 15, buyer: BUYER });
    const { done } = await sales.submit({ saleId: sale.saleId, transaction: await walletSign(sale.transaction) });
    await done;
    // the mirror node does not show the UNLISTED yet
    deps.readDisplay.mockResolvedValue({ events: [ev(10, listed(UMINA, 15, "45"))] });
    await expect(sales.prepare({ token: "umina", serial: 15, buyer: "0.0.7007" })).rejects.toMatchObject({ code: "not_available" });
    client.close();
  });

  test("refuses a buyer holding less HBAR than the price, before anything is signed", async () => {
    const key = { _type: "ED25519", key: buyerKey.publicKey.toStringRaw() };
    const { sales, client, deps } = setup({ account: { key, notAssociated: [], balance: 44_99999999 } });
    await expect(sales.prepare({ token: "umina", serial: 15, buyer: BUYER })).rejects.toMatchObject({ code: "insufficient_balance" });
    expect(sales.pendingCount()).toBe(0);
    // exactly the price is enough: UA pays the fee
    deps.buyerAccount.mockResolvedValueOnce({ key, notAssociated: [], balance: 45_00000000 });
    await sales.prepare({ token: "umina", serial: 15, buyer: BUYER });
    client.close();
  });

  test("publicKeyOf reads ED25519 and ECDSA keys, not key lists", () => {
    expect(publicKeyOf({ _type: "ED25519", key: buyerKey.publicKey.toStringRaw() }).toStringRaw()).toBe(buyerKey.publicKey.toStringRaw());
    expect(publicKeyOf({ _type: "ECDSA_SECP256K1", key: operatorKey.publicKey.toStringRaw() })).not.toBeNull();
    expect(publicKeyOf({ _type: "ProtobufEncoded", key: "00" })).toBeNull();
    expect(publicKeyOf(null)).toBeNull();
  });
});

describe("submit", () => {
  test("submits the buyer-signed sale, then records SALE, posts UNLISTED and rebuilds the catalog", async () => {
    const { sales, state, client, catalog } = setup();
    const prepared = await sales.prepare({ token: "umina", serial: 15, buyer: BUYER });
    const { result, done } = await sales.submit({ saleId: prepared.saleId, transaction: await walletSign(prepared.transaction) });
    expect(result).toEqual({ status: "SUCCESS", transactionId: prepared.transactionId, stoneId: "UMINA-2026-AG-01", nfts: [`${UMINA}/15`] });
    // the transaction sent is the server's, with all three signatures
    const sent = execute.mock.contexts[0];
    for (const k of [operatorKey, treasuryKey, buyerKey]) expect(k.publicKey.verifyTransaction(sent)).toBe(true);
    await done;
    expect(state.submitted.map((s) => [s.topicId, s.message.event])).toEqual([
      [env.HCS_TOPIC_ID, "SALE"],
      [env.HCS_DISPLAY_TOPIC_ID, "UNLISTED"],
    ]);
    expect(state.submitted[0].message).toMatchObject({ buyer_id: BUYER, seller_id: TREASURY, sold_for: "45", ref: prepared.transactionId });
    expect(state.submitted[1].message).toMatchObject({ stone_id: "UMINA-2026-AG-01", reason: "sold" });
    expect(catalog.request).toHaveBeenCalledTimes(1);
    // sold: the same item cannot be prepared again, and the sale cannot be sent twice
    await expect(sales.prepare({ token: "umina", serial: 15, buyer: BUYER })).rejects.toMatchObject({ code: "not_listed" });
    await expect(sales.submit({ saleId: prepared.saleId, transaction: await walletSign(prepared.transaction) })).rejects.toMatchObject({ code: "expired" });
    client.close();
  });

  test("an Achala's SALE names its stones", async () => {
    const { sales, state, client } = setup();
    const prepared = await sales.prepare({ token: "achala", serial: 6, buyer: BUYER });
    const { done } = await sales.submit({ saleId: prepared.saleId, transaction: await walletSign(prepared.transaction) });
    await done;
    expect(state.submitted[0].message).toMatchObject({ stone_id: "ACHALA-2026-PE-02", from_stone_ids: ["UMINA-2026-AU-01"], umina_serials: ["19"] });
    client.close();
  });

  test("refuses an expired sale, an unsigned one, another key's signature, and another transaction", async () => {
    const { sales, state, client } = setup();
    const a = await sales.prepare({ token: "umina", serial: 15, buyer: BUYER });
    await expect(sales.submit({ saleId: a.saleId, transaction: a.transaction })).rejects.toMatchObject({ code: "bad_signature" });
    await expect(sales.submit({ saleId: a.saleId, transaction: await walletSign(a.transaction, otherKey) })).rejects.toMatchObject({ code: "bad_signature" });
    const b = await sales.prepare({ token: "achala", serial: 6, buyer: BUYER });
    await expect(sales.submit({ saleId: a.saleId, transaction: await walletSign(b.transaction) })).rejects.toMatchObject({ code: "bad_signature" });
    await expect(sales.submit({ saleId: a.saleId, transaction: "bm90IGEgdHg=" })).rejects.toMatchObject({ code: "bad_request" });
    expect(execute).not.toHaveBeenCalled();
    state.now += VALID_SECONDS * 1000 + 1;
    await expect(sales.submit({ saleId: a.saleId, transaction: await walletSign(a.transaction) })).rejects.toMatchObject({ code: "expired" });
    client.close();
  });

  test("a sale Hedera refuses unlocks the item and records nothing", async () => {
    const { sales, state, client, catalog } = setup();
    execute.mockRejectedValueOnce(Object.assign(new Error("receipt"), { status: { toString: () => "INSUFFICIENT_PAYER_BALANCE" } }));
    const a = await sales.prepare({ token: "umina", serial: 15, buyer: BUYER });
    await expect(sales.submit({ saleId: a.saleId, transaction: await walletSign(a.transaction) })).rejects.toMatchObject({
      code: "failed",
      details: { status: "INSUFFICIENT_PAYER_BALANCE" },
    });
    expect(state.submitted).toEqual([]);
    expect(catalog.request).not.toHaveBeenCalled();
    await sales.prepare({ token: "umina", serial: 15, buyer: BUYER }); // unlocked
    client.close();
  });

  test("when SALE or UNLISTED fails after the sale settled, says how to record it by hand and still rebuilds", async () => {
    const { sales, state, deps, client, catalog } = setup();
    deps.submitEvent.mockRejectedValue(new Error("topic busy"));
    const a = await sales.prepare({ token: "umina", serial: 15, buyer: BUYER });
    const { result, done } = await sales.submit({ saleId: a.saleId, transaction: await walletSign(a.transaction) });
    expect(result.status).toBe("SUCCESS");
    await done;
    expect(state.logs.join("\n")).toMatch(/SALE was not recorded \(topic busy\); record it by hand/);
    expect(state.logs.join("\n")).toMatch(/UNLISTED was not posted \(topic busy\); post it by hand: displayEvent.js unlisted 15 --reason sold/);
    expect(catalog.request).toHaveBeenCalledTimes(1);
    client.close();
  });
});

describe("HTTP", () => {
  let server, base, s;
  const post = (path, body) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

  beforeEach(async () => {
    s = setup();
    const app = createApp({ sales: s.sales, catalog: s.catalog, network: "testnet", limits: { prepare: 3, submit: 3 }, log: s.deps.log });
    server = await new Promise((resolve) => {
      const srv = app.listen(0, "127.0.0.1", () => resolve(srv));
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    s.client.close();
  });

  test("prepare and submit a sale", async () => {
    const prepared = await (await post("/api/sale/prepare", { token: "umina", serial: 15, buyer: BUYER })).json();
    const res = await post("/api/sale/submit", { saleId: prepared.saleId, transaction: await walletSign(prepared.transaction) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "SUCCESS", stoneId: "UMINA-2026-AG-01" });
  });

  test("errors answer a code and an HTTP status", async () => {
    let res = await post("/api/sale/prepare", { token: "umina", serial: 16, buyer: BUYER });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_listed", message: expect.any(String) } });
    res = await post("/api/sale/prepare", "{not json");
    expect([res.status, (await res.json()).error.code]).toEqual([400, "bad_request"]);
    res = await post("/api/sale/submit", { saleId: "00000000-0000-0000-0000-000000000000", transaction: "AAAA" });
    expect([res.status, (await res.json()).error.code]).toEqual([410, "expired"]);
    res = await fetch(`${base}/api/nothing`);
    expect(res.status).toBe(404);
  });

  test("an item another buyer is buying answers 409 being_bought with Retry-After", async () => {
    await post("/api/sale/prepare", { token: "umina", serial: 15, buyer: BUYER });
    const res = await post("/api/sale/prepare", { token: "umina", serial: 15, buyer: "0.0.7007" });
    expect(res.status).toBe(409);
    expect(res.headers.get("retry-after")).toBe(String(VALID_SECONDS));
    expect((await res.json()).error).toMatchObject({ code: "being_bought", retryAfter: VALID_SECONDS });
  });

  test("rate limits prepare per client", async () => {
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await post("/api/sale/prepare", { token: "gold", serial: 1, buyer: BUYER })).status);
    expect(codes).toEqual([400, 400, 400, 429]);
  });

  test("health says the network and the catalog's state, no keys", async () => {
    const body = await (await fetch(`${base}/api/health`)).json();
    expect(body).toEqual({ ok: true, network: "testnet", pendingSales: 0, catalog: { running: false, lastBuilt: null } });
    expect(JSON.stringify(body)).not.toMatch(new RegExp(operatorKey.toStringRaw()));
  });
});

describe("rateLimit", () => {
  test("a window resets", () => {
    let t = 0;
    const limit = rateLimit({ limit: 1, windowMs: 1000, now: () => t });
    const next = jest.fn();
    const res = { set: jest.fn() };
    limit({ ip: "a" }, res, next);
    limit({ ip: "a" }, res, next);
    expect(next.mock.calls.map((c) => c[0]?.code)).toEqual([undefined, "rate_limited"]);
    t = 1001;
    limit({ ip: "a" }, res, next);
    expect(next.mock.calls[2][0]).toBeUndefined();
  });
});

describe("catalog queue", () => {
  test("one build at a time; requests during a build make one more build", async () => {
    let finish;
    const run = jest.fn(() => new Promise((resolve) => (finish = resolve)));
    const queue = createCatalogQueue("/tmp/data", { run, now: () => 0 });
    const first = queue.request();
    queue.request();
    queue.request();
    expect(run).toHaveBeenCalledTimes(1);
    finish(0);
    await new Promise((r) => setImmediate(r));
    expect(run).toHaveBeenCalledTimes(2);
    finish(0);
    await first;
    expect(queue.status()).toEqual({ running: false, lastBuilt: "1970-01-01T00:00:00.000Z", lastCode: 0 });
  });
});

describe("serverProblems", () => {
  test("testnet only, with every key and the catalog folder", () => {
    expect(serverProblems(env)).toEqual([]);
    expect(serverProblems({ ...env, NETWORK: undefined })[0]).toMatch(/NETWORK is not set/);
    expect(serverProblems({ ...env, NETWORK: "mainnet" })[0]).toMatch(/mainnet|not enabled/);
    expect(serverProblems({ ...env, OPERATOR_KEY: "" })).toContain("OPERATOR_KEY is not set");
    expect(serverProblems({ ...env, CATALOG_DIR: "/no/such/folder" })).toContain("CATALOG_DIR /no/such/folder does not exist");
    expect(serverProblems({ ...env, TREASURY_KEY: undefined })[0]).toMatch(/TREASURY_KEY/);
  });
});
