import fs from 'node:fs';
import https from 'node:https';
import next from 'next';

// --- 設定 ---
const port = Number(process.env.PORT || 3000);
const hostname = process.env.HOST || '0.0.0.0';
const keyPath = './certificates/lineai-dev-mi10490jp-com-key.pem';
const certPath = './certificates/lineai-dev-mi10490jp-com-fullchain.pem';

// Next を本番モード(dev:false)で準備
const app = next({ dev: false, hostname, port });
const handle = app.getRequestHandler();

(async () => {
  try {
    await app.prepare();

    const server = https.createServer(
      {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath),
      },
      (req, res) => handle(req, res)
    );

    server.listen(port, hostname, () => {
      console.log(`[HTTPS] Next app running on https://${hostname}:${port}`);
    });
  } catch (e) {
    console.error('Failed to start HTTPS server:', e);
    process.exit(1);
  }
})();
