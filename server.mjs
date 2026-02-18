import 'dotenv/config';
import fs from 'node:fs';
import https from 'node:https';
import next from 'next';

console.log("[boot] server.mjs loaded", {
  NODE_ENV: process.env.NODE_ENV,
  APP_ENV: process.env.APP_ENV,
  PORT: process.env.PORT,
  HOST: process.env.HOST,
  DEBUG_AI: process.env.DEBUG_AI,
  DEBUG_BING: process.env.DEBUG_BING,
  DEBUG_GROUNDING: process.env.DEBUG_GROUNDING,
});

process.on('uncaughtException', (e) => console.error('[uncaught]', e));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));

const port = Number(process.env.PORT || 3000);
const hostname = process.env.HOST || '0.0.0.0';
const keyPath = './certificates/lineai-dev-mi10490jp-com-key.pem';
const certPath = './certificates/lineai-dev-mi10490jp-com-fullchain.pem';

let key, cert;
try {
  key = fs.readFileSync(keyPath);
  cert = fs.readFileSync(certPath);
  console.log("[boot] loaded certs", { keyPath, certPath });
} catch (e) {
  console.error("[boot] failed to read TLS certs", e);
  process.exit(1);
}

const app = next({ dev: false, hostname, port });
const handle = app.getRequestHandler();

(async () => {
  try {
    console.log("[boot] preparing Next app...");
    await app.prepare();
    console.log("[boot] Next prepared. Starting HTTPS server...");

    const server = https.createServer({ key, cert }, (req, res) => handle(req, res));
    server.listen(port, hostname, () => {
      console.log(`[ready] HTTPS on https://${hostname}:${port}`);
    });
  } catch (e) {
    console.error('[boot] failed to start', e);
    process.exit(1);
  }
})();
