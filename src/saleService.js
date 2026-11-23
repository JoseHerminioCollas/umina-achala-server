/**
 * @file saleService.js
 * @description The sale backend's logic (umina-achala-web#116), without HTTP:
 * prepare a sale of an item UA holds itself, then submit it once the buyer has
 * signed it in their wallet. Phase 2B sells only from the Treasury.
 *
 * prepare({ token, serial, buyer }):
 *   checks the item is listed since it last came to the Treasury (the price
 *   comes from the display topic, never from the browser), the Treasury holds
 *   it (an Achala with its stones, sale/lib.js planSale), the buyer's account
 *   can receive the NFTs, and no other sale of it is pending. Builds the one
 *   atomic transfer (sale/lib.js saleTransaction) with UA as payer, one node
 *   and a short validity window; UA signs, and the Treasury when it is its
 *   own account. The sale is kept in memory until it expires and locks the
 *   item.
 *
 * submit({ saleId, transaction }):
 *   takes only the buyer's signature from the transaction the wallet sends
 *   back and adds it to the transaction the server built, so nothing in the
 *   body can be changed; checks it against the buyer's key on the mirror node,
 *   submits, and waits for the receipt. Then, in the background (after()):
 *   SALE on the provenance topic and UNLISTED (reason "sold") on the display
 *   topic, as a sale from the command line does (umina-achala-chain's
 *   recordSold), a wait until the mirror node shows the UNLISTED, and a
 *   catalog rebuild.
 *
 * Errors are SaleError with a code the site shows (#58): bad_request,
 * not_listed, not_available, not_associated, unsupported_account, expired,
 * bad_signature, failed.
 */

import { randomUUID } from "crypto";
import { AccountId, Hbar, PublicKey, Transaction } from "umina-achala-chain/sdk";
import { planSale, recordSold, saleTransaction } from "umina-achala-chain/sale";
import { loadSubmitKey, submitEvent } from "umina-achala-chain/hcs";
import { parseEcdsaKey } from "umina-achala-chain/keys";
import { readDisplay, readProvenance } from "umina-achala-chain/provenance";
import { buyerAccount, latestArrival } from "umina-achala-chain/mirror";
import { mintOfSerial } from "umina-achala-chain/achala";
import { currentListing } from "umina-achala-chain/display";
import { TOKEN_CLASSES } from "umina-achala-chain/token";

/** How long a prepared sale can be signed and submitted, in seconds (Hedera allows up to 180). */
export const VALID_SECONDS = 120;
/** How long a sold item is refused before the mirror node shows its new holder, in ms. */
const SOLD_HOLD_MS = 5 * 60_000;
/** How many times to look for the UNLISTED on the mirror node, every 2 s, before rebuilding anyway. */
const UNLISTED_TRIES = 30;

export class SaleError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {object} [details]
   */
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const ACCOUNT_ID = /^0\.0\.\d{1,15}$/;
const SERIAL = /^[1-9]\d{0,9}$/;

/** The checked input of prepare, or a SaleError. */
export function checkPrepareInput(body) {
  const { token, serial, buyer } = body ?? {};
  const problems = [];
  if (!Object.hasOwn(TOKEN_CLASSES, String(token))) problems.push(`token must be ${Object.keys(TOKEN_CLASSES).join(" or ")}`);
  if (!SERIAL.test(String(serial ?? ""))) problems.push("serial must be a whole number from 1");
  if (!ACCOUNT_ID.test(String(buyer ?? ""))) problems.push("buyer must be an account ID, 0.0.N");
  if (problems.length) throw new SaleError("bad_request", problems.join("; "));
  return { tokenClass: String(token), serial: String(serial), buyer: String(buyer) };
}

/** The checked input of submit, or a SaleError. */
export function checkSubmitInput(body) {
  const { saleId, transaction } = body ?? {};
  if (typeof saleId !== "string" || !/^[0-9a-f-]{36}$/.test(saleId)) throw new SaleError("bad_request", "saleId is missing");
  if (typeof transaction !== "string" || !transaction || transaction.length > 100_000 || !/^[A-Za-z0-9+/=]+$/.test(transaction)) {
    throw new SaleError("bad_request", "transaction must be the signed transaction in base64");
  }
  return { saleId, transaction };
}

/** The buyer's public key from the mirror node's { _type, key }; null for a key list or threshold key. */
export function publicKeyOf(mirrorKey) {
  if (!mirrorKey?.key) return null;
  if (mirrorKey._type === "ED25519") return PublicKey.fromStringED25519(mirrorKey.key);
  if (mirrorKey._type === "ECDSA_SECP256K1") return PublicKey.fromStringECDSA(mirrorKey.key);
  return null;
}

const nftKey = (nftId) => nftId.toString();

/**
 * @param {object} options
 * @param {import("@hashgraph/sdk").Client} options.client UA's client (operator OPERATOR_ID)
 * @param {Record<string, string | undefined>} options.env
 * @param {{ request: () => void }} options.catalog the catalog rebuild queue
 * @param {object} [options.deps] mirror node, topics and clock, replaced in tests
 */
export function createSaleService({ client, env, catalog, deps = {} }) {
  const d = {
    readProvenance,
    readDisplay,
    latestArrival,
    buyerAccount,
    holders: undefined, // planSale's default, the mirror node
    submitEvent,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: console,
    ...deps,
  };
  const operatorKey = parseEcdsaKey(env.OPERATOR_KEY);
  const treasuryKey = env.TREASURY_ID === env.OPERATOR_ID ? null : parseEcdsaKey(env.TREASURY_KEY);
  const submitKey = loadSubmitKey(env);

  /** saleId → the prepared sale */
  const pending = new Map();
  /** nft ID → the saleId that locks it, or "sold" until a time */
  const locks = new Map();

  function sweep() {
    const now = d.now();
    for (const [id, sale] of pending) {
      if (sale.expiresAt <= now) {
        pending.delete(id);
        for (const k of sale.nftKeys) if (locks.get(k)?.saleId === id) locks.delete(k);
      }
    }
    for (const [k, lock] of locks) if (lock.until && lock.until <= now) locks.delete(k);
  }

  function pickNode() {
    const nodes = Object.values(client.network ?? {});
    if (!nodes.length) throw new SaleError("failed", "no Hedera node to send to");
    return AccountId.fromString(String(nodes[Math.floor(Math.random() * nodes.length)]));
  }

  async function prepare(body) {
    const { tokenClass, serial, buyer } = checkPrepareInput(body);
    sweep();
    const tokenId = env[TOKEN_CLASSES[tokenClass].envVar];
    if (buyer === env.TREASURY_ID || buyer === env.OPERATOR_ID) {
      throw new SaleError("bad_request", "the buyer cannot be UA's own account");
    }

    // The item: minted, listed since it last came to the Treasury, and its price
    const [provenance, display] = await Promise.all([d.readProvenance(env), d.readDisplay(env)]);
    if (provenance.problem || display.problem) throw new SaleError("failed", provenance.problem ?? display.problem);
    const mint = mintOfSerial(provenance.events, tokenId, serial);
    if (!mint) throw new SaleError("not_listed", `${tokenId}/${serial} is not for sale`);
    const since = await d.latestArrival(tokenId, serial, env.TREASURY_ID);
    const listing = currentListing(display.events, tokenId, serial, since);
    if (!listing.listed) throw new SaleError("not_listed", `${mint.event.stone_id} is not for sale`);

    // What moves, held by the Treasury (an Achala with its stones)
    const plan = await planSale(env, provenance.events, { tokenClass, serial }, d.holders ? { holders: d.holders } : {});
    if (plan.problems.length) throw new SaleError("not_available", `${mint.event.stone_id} is not available`, { problems: plan.problems });
    const nftKeys = plan.nftIds.map(nftKey);
    if (nftKeys.some((k) => locks.has(k))) {
      throw new SaleError("not_available", `${mint.event.stone_id} is being bought or was just sold`);
    }

    // The buyer can receive every token that moves
    const tokenIds = [...new Set(plan.nftIds.map((id) => id.tokenId.toString()))];
    const account = await d.buyerAccount(buyer, tokenIds);
    if (!account) throw new SaleError("bad_request", `account ${buyer} does not exist on ${env.NETWORK}`);
    if (!publicKeyOf(account.key)) {
      throw new SaleError("unsupported_account", "the buyer's account must have a single ED25519 or ECDSA key");
    }
    if (account.notAssociated.length) {
      throw new SaleError("not_associated", `associate ${account.notAssociated.join(" and ")} with ${buyer} first`, {
        tokens: account.notAssociated,
      });
    }

    // The transfer: UA pays the fee, one node, a short validity window; UA and the Treasury sign
    const price = Hbar.fromString(listing.price);
    const parties = { uaId: env.OPERATOR_ID, treasuryId: env.TREASURY_ID, buyerId: buyer, price };
    let tx = saleTransaction(parties, plan)
      .setNodeAccountIds([pickNode()])
      .setTransactionValidDuration(VALID_SECONDS)
      .freezeWith(client);
    tx = await tx.sign(operatorKey);
    if (treasuryKey) tx = await tx.sign(treasuryKey);

    const saleId = randomUUID();
    const expiresAt = d.now() + VALID_SECONDS * 1000;
    pending.set(saleId, { tx, plan, parties, buyerKey: account.key, nftKeys, expiresAt, stoneId: mint.event.stone_id });
    for (const k of nftKeys) locks.set(k, { saleId });
    return {
      saleId,
      transaction: Buffer.from(tx.toBytes()).toString("base64"),
      transactionId: tx.transactionId.toString(),
      stoneId: mint.event.stone_id,
      price: { amount: listing.price, currency: "HBAR" },
      nfts: nftKeys,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  async function submit(body) {
    const { saleId, transaction } = checkSubmitInput(body);
    sweep();
    const sale = pending.get(saleId);
    if (!sale) throw new SaleError("expired", "this sale has expired or was already submitted; start again");

    // Only the buyer's signature is taken from the wallet's transaction
    const buyerKey = publicKeyOf(sale.buyerKey);
    let signed;
    try {
      signed = Transaction.fromBytes(Buffer.from(transaction, "base64"));
    } catch {
      throw new SaleError("bad_request", "transaction is not a Hedera transaction");
    }
    if (signed.transactionId?.toString() !== sale.tx.transactionId.toString()) {
      throw new SaleError("bad_signature", "this is not the transaction the server prepared");
    }
    try {
      sale.tx.addSignature(buyerKey, signed.getSignatures());
    } catch {
      throw new SaleError("bad_signature", "the buyer's signature is missing");
    }
    if (!buyerKey.verifyTransaction(sale.tx)) throw new SaleError("bad_signature", "the buyer's signature does not match");

    // One submission per sale
    pending.delete(saleId);
    let receipt, saleTxId;
    try {
      const response = await sale.tx.execute(client);
      saleTxId = response.transactionId.toString();
      receipt = await response.getReceipt(client);
    } catch (err) {
      for (const k of sale.nftKeys) locks.delete(k);
      const status = err?.status?.toString?.() ?? err?.message ?? "unknown";
      d.log.error(`sale ${saleId} (${sale.stoneId}) failed: ${status}`);
      throw new SaleError("failed", `the sale did not go through: ${status}`, { status });
    }
    for (const k of sale.nftKeys) locks.set(k, { until: d.now() + SOLD_HOLD_MS });
    d.log.log(`sold ${sale.stoneId} (${sale.nftKeys.join(", ")}) to ${sale.parties.buyerId}: ${saleTxId}`);

    const done = after(sale, saleTxId);
    return {
      result: {
        status: receipt.status.toString(),
        transactionId: saleTxId,
        stoneId: sale.stoneId,
        nfts: sale.nftKeys,
      },
      done,
    };
  }

  /** After a settled sale: SALE and UNLISTED, a wait for the mirror node, a catalog rebuild. Never throws. */
  async function after(sale, saleTxId) {
    const { plan, parties } = sale;
    const tokenId = plan.tokenId.toString();
    const serial = String(plan.nftId.serial);
    try {
      const recorded = await recordSold(client, env, { ...parties, saleTxId }, plan, { submitKey, submit: d.submitEvent });
      for (const p of recorded.problems) d.log.error(`❌ sale ${saleTxId} (${sale.stoneId}) settled, but ${p}`);
      // The builder reads the display topic from the mirror node: wait until it shows the UNLISTED
      if (recorded.unlistedTxId) {
        for (let i = 0; i < UNLISTED_TRIES; i++) {
          const display = await d.readDisplay(env);
          if (!display.problem && !currentListing(display.events, tokenId, serial, null).listed) break;
          await d.sleep(2000);
        }
      }
    } catch (err) {
      d.log.error(`after sale ${saleTxId}: ${err.message}`);
    }
    catalog.request();
  }

  return { prepare, submit, pendingCount: () => (sweep(), pending.size) };
}
