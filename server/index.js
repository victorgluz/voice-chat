import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { config } from '../config/index.js';
import { initDatabase } from './database/index.js';
import { mediasoupServer } from './mediasoup/index.js';
import { createApp } from './app.js';
import { initSocket } from './socket/index.js';

function createServer(app) {
  if (!config.tls.enabled) return http.createServer(app);
  return https.createServer(
    {
      cert: fs.readFileSync(config.tls.certPath),
      key: fs.readFileSync(config.tls.keyPath),
    },
    app
  );
}

async function main() {
  initDatabase();
  await mediasoupServer.init();

  const app = createApp();
  const server = createServer(app);
  initSocket(server);

  server.listen(config.http.port, config.http.host, () => {
    const { lanIp, port, scheme } = config.http;
    const suffix = (port === 80 || port === 443) ? '' : `:${port}`;
    console.log('');
    console.log('  🎙️  LAN Voice Chat rodando');
    console.log(`  → Local:   ${scheme}://localhost${suffix}`);
    console.log(`  → Rede:    ${scheme}://${lanIp}${suffix}`);
    console.log('');
    if (config.tls.enabled) {
      console.log('  🔒 HTTPS ativo (cert self-signed). Na 1ª vez cada pessoa aceita o');
      console.log('     aviso do navegador ("avançado → continuar"). Aí o microfone libera.');
    } else {
      console.log('  ⚠️  HTTP puro: o microfone NÃO funciona por IP de LAN (só em localhost).');
      console.log('     Rode  npm run gen-cert  e reinicie para servir por HTTPS.');
    }
    console.log('');
    console.log('  Compartilhe o endereço de rede com os outros computadores da LAN.');
    console.log('');
  });
}

main().catch((err) => {
  console.error('Falha ao iniciar o servidor:', err);
  process.exit(1);
});
