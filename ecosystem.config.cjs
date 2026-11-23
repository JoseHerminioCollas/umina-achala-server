// pm2 config for the sale backend (umina-achala-web#116). On the server, from
// this repo's folder:
//
//   UMINA_ACHALA_ENV_FILE=<path to the testnet env file> pm2 start ecosystem.config.cjs
//   pm2 save && pm2 startup            # keep it running across reboots
//   pm2 logs umina-achala-sale
//
// The keys are never in this repo: the env file lives outside it (chmod 600),
// and its name must contain "testnet". CATALOG_DIR in that file is the site's
// data folder (the live site's build/data). See README.md.
module.exports = {
  apps: [
    {
      name: "umina-achala-sale",
      script: "src/saleServer.js",
      cwd: __dirname,
      // the pending sales and the catalog queue live in memory: one process only
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      time: true,
      env: {
        NETWORK: "testnet",
        ENV_FILE: process.env.UMINA_ACHALA_ENV_FILE,
        PORT: process.env.PORT ?? "8787",
      },
    },
  ],
};
