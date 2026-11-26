/**
 * @file app.js
 * @description The sale backend's HTTP side (umina-achala-web#116), Express 5,
 * JSON only. Nginx proxies the site's /api/ here, so the site calls its own
 * domain and there is no CORS.
 *
 *   POST /api/sale/prepare  { token, serial, buyer }     → the transaction for the buyer to sign
 *   POST /api/sale/submit   { saleId, transaction }      → the sale's receipt
 *   GET  /api/health                                     → up, network, last catalog build
 *
 * An error answers { error: { code, message, ... } } with an HTTP status.
 */

import express from "express";
import { SaleError } from "./saleService.js";

const STATUS = {
  bad_request: 400,
  bad_signature: 400,
  not_listed: 404,
  expired: 410,
  replaced: 410,
  not_available: 409,
  being_bought: 409,
  not_associated: 409,
  insufficient_balance: 409,
  unsupported_account: 422,
  rate_limited: 429,
  failed: 502,
};

/**
 * Requests per client IP in a fixed window, kept in memory.
 * @param {{ limit: number, windowMs: number, now?: () => number }} options
 */
export function rateLimit({ limit, windowMs, now = () => Date.now() }) {
  const hits = new Map();
  return (req, res, next) => {
    const t = now();
    for (const [ip, h] of hits) if (h.reset <= t) hits.delete(ip);
    const h = hits.get(req.ip) ?? { count: 0, reset: t + windowMs };
    h.count++;
    hits.set(req.ip, h);
    if (h.count > limit) {
      res.set("Retry-After", String(Math.ceil((h.reset - t) / 1000)));
      return next(new SaleError("rate_limited", "too many requests; wait a minute and try again"));
    }
    next();
  };
}

/**
 * @param {object} options
 * @param {ReturnType<import("./saleService.js").createSaleService>} options.sales
 * @param {{ status: () => object }} options.catalog
 * @param {string} options.network
 * @param {{ prepare?: number, submit?: number, windowMs?: number, now?: () => number }} [options.limits]
 * @param {{ log: Function, error: Function }} [options.log]
 */
export function createApp({ sales, catalog, network, limits = {}, log = console }) {
  const app = express();
  app.disable("x-powered-by");
  // Behind Nginx on the same machine: the client's IP comes from X-Forwarded-For
  app.set("trust proxy", "loopback");
  app.use(express.json({ limit: "200kb" }));

  const windowMs = limits.windowMs ?? 60_000;
  const now = limits.now;

  app.get("/api/health", (req, res) => {
    res.json({ ok: true, network, pendingSales: sales.pendingCount(), catalog: catalog.status() });
  });

  app.post("/api/sale/prepare", rateLimit({ limit: limits.prepare ?? 10, windowMs, now }), async (req, res) => {
    res.json(await sales.prepare(req.body));
  });

  app.post("/api/sale/submit", rateLimit({ limit: limits.submit ?? 10, windowMs, now }), async (req, res) => {
    const { result } = await sales.submit(req.body);
    res.json(result);
  });

  app.use((req, res) => res.status(404).json({ error: { code: "not_found", message: "no such endpoint" } }));

  // Express 5 passes a rejected async handler here
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof SaleError) {
      if (err.details?.retryAfter) res.set("Retry-After", String(err.details.retryAfter));
      return res.status(STATUS[err.code] ?? 400).json({ error: { code: err.code, message: err.message, ...err.details } });
    }
    if (err?.type === "entity.parse.failed" || err?.type === "entity.too.large") {
      return res.status(400).json({ error: { code: "bad_request", message: "the body must be JSON" } });
    }
    log.error(`unexpected error on ${req.method} ${req.path}:`, err);
    res.status(500).json({ error: { code: "failed", message: "something went wrong; try again" } });
  });

  return app;
}
