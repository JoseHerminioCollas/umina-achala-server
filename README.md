# umina-achala-server

The sale backend of [umina-achala.pe](https://umina-achala.pe): a small Node service that lets a visitor buy an Umiña stone or an Achala piece with **testnet HBAR** from their wallet (HashPack), and keeps the site's catalog current.

It is a thin HTTP layer. The sale itself (what moves, the one atomic transfer, and the `SALE` and `UNLISTED` events) is in [umina-achala-chain](https://github.com/umina-achala/umina-achala-chain), which this service installs as a dependency. A sale from the command line (`sellOwnItem.js`) and a sale on the site use the same code and end the same way.

**Phase 2B: testnet only.** The service refuses to start on any other network.

## How a sale works

```
browser (site)                 this service                         Hedera
--------------                 ------------                         ------
POST /api/sale/prepare  ──▶    checks the item is LISTED, held by
{ token, serial, buyer }       the Treasury and not pending; the
                               buyer can receive it; price from the
                               display topic. Builds the transfer
                               (UA pays the fee, 2-minute window),
                               signs as UA (and the Treasury).
                        ◀──    { saleId, transaction, price, ... }
wallet signs (HashPack)
POST /api/sale/submit   ──▶    takes only the buyer's signature,
{ saleId, transaction }        checks it, submits                ──▶  transfer
                        ◀──    { status, transactionId }
                               then: SALE (provenance topic),     ──▶  HCS
                               UNLISTED "sold" (display topic),
                               catalog rebuild
```

- The price, the seller, the payer and the NFTs are decided here, never by the browser. Only the buyer's signature is taken from the wallet's transaction, and it is added to the transaction this service built, so nothing in it can be changed.
- One pending sale per item; a prepared sale expires after 2 minutes.
- Rate limits per client IP.

### Endpoints

| | Body | Answer |
|---|---|---|
| `POST /api/sale/prepare` | `{ "token": "umina" \| "achala", "serial": 15, "buyer": "0.0.N" }` | `{ saleId, transaction (base64), transactionId, stoneId, price, nfts, expiresAt }` |
| `POST /api/sale/submit` | `{ "saleId": "...", "transaction": "<base64, signed by the buyer>" }` | `{ status, transactionId, stoneId, nfts }` |
| `GET /api/health` | | `{ ok, network, pendingSales, catalog }` |

An error answers `{ "error": { "code", "message", ... } }`:

| Code | HTTP | Meaning |
|---|---|---|
| `bad_request` | 400 | The input's shape, an unknown account, or UA's own account as buyer |
| `bad_signature` | 400 | Not the prepared transaction, or not signed by the buyer's key |
| `not_listed` | 404 | Not for sale |
| `not_available` | 409 | Not held by the Treasury, mounted in an Achala, or just sold |
| `being_bought` | 409 | Another buyer's sale of the item is pending; `retryAfter` (and the `Retry-After` header) gives the seconds until it ends. The same buyer starting again replaces their own pending sale |
| `not_associated` | 409 | The buyer must associate `tokens` first |
| `insufficient_balance` | 409 | The buyer's account holds less HBAR than the price; refused before anything is signed, so UA pays no fee for a transfer the network would refuse |
| `expired` | 410 | The prepared sale expired or was already submitted |
| `replaced` | 410 | The same buyer started the purchase again: a newer sale replaced this one; sign the newest one |
| `unsupported_account` | 422 | The buyer's account has a key list or threshold key |
| `rate_limited` | 429 | Too many requests |
| `failed` | 502 | Hedera refused the sale (`status`) |

## The catalog

The site reads only `data/catalog.json`, built by umina-achala-chain's catalog builder. This service reruns the builder into `CATALOG_DIR`, one run at a time:

- after a sale on the site, once the mirror node shows the `UNLISTED`;
- whenever the display topic has a new message (checked about once a minute): a sale from the command line, or a listing changed by hand with `displayEvent.js`;
- once at start.

## Keys and configuration

**Keys never come into this repo.** They live in an env file on the server, outside the repo, readable only by the account that runs the service (`chmod 600`). Its file name must contain `testnet`.

| Variable | |
|---|---|
| `OPERATOR_ID`, `OPERATOR_KEY` | UA: pays the fees and receives the price |
| `TREASURY_ID` (`TREASURY_KEY` if it is not the operator) | Holds the NFTs for sale |
| `UMINA_TOKEN_ID`, `ACHALA_TOKEN_ID` | The tokens |
| `HCS_TOPIC_ID`, `HCS_DISPLAY_TOPIC_ID` (`HCS_SUBMIT_KEY` if the topics have one) | Provenance and display topics |
| `CATALOG_DIR` | The site's data folder (the live site's `build/data`) |
| `PORT` | Optional, 8787; the service listens on 127.0.0.1 only |

`NETWORK=testnet` and `ENV_FILE` are set by the pm2 config.

## Run it on the server (pm2)

```bash
git clone https://github.com/umina-achala/umina-achala-server.git && cd umina-achala-server
npm ci
UMINA_ACHALA_ENV_FILE=/path/to/umina-achala.testnet.env pm2 start ecosystem.config.cjs
pm2 save && pm2 startup     # keep it running across reboots
pm2 logs umina-achala-sale
```

Nginx sends the site's `/api/` here (the site's copy, which the server's file is copied from, is umina-achala-web's `deploy/nginx/umina-achala.conf`):

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    add_header Cache-Control "no-store" always;
}
```

- No trailing slash on `proxy_pass`: the path arrives unchanged (`/api/sale/prepare`), as the routes expect.
- `X-Forwarded-For`: the rate limit counts per visitor IP. The app trusts only a proxy on loopback, so a header a visitor sends cannot change it.
- `no-store`: sale and health replies are never cached, errors included.

## Develop

```bash
npm install
npm test        # the mirror node, the topics and Hedera's execute are mocked
```

`umina-achala-chain` is pinned to a tag of the chain repo (`github:umina-achala/umina-achala-chain#vX.Y.Z`, now `v0.2.0-testnet.3`); `package-lock.json` records the tag's commit, which `npm ci` installs on the server.

To work against chain changes that are not tagged yet, install the folder next to this one without changing `package.json`:

```
npm install ../umina-achala-chain --no-save
```

`npm ci` puts the tagged version back. For a new chain release: tag the chain repo, push the tag to both remotes, change the tag in `package.json`, run `npm install` and `npm test`, and commit `package.json` with `package-lock.json`.
