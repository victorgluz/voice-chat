/**
 * Gera um certificado self-signed para servir o app por HTTPS na LAN.
 *
 * Por que precisamos disso: navegadores só liberam o microfone
 * (getUserMedia) em "secure context" — https:// ou localhost. Servindo por
 * IP de LAN em http:// puro, a captura de voz nunca é permitida.
 *
 * O cert cobre, via Subject Alternative Name (SAN):
 *   - localhost / 127.0.0.1 / ::1
 *   - o IP de LAN detectado (config.http.lanIp)
 *   - quaisquer hosts/IPs extras passados em CERT_HOSTS (separados por vírgula)
 *
 * Uso:
 *   npm run gen-cert
 *   CERT_HOSTS="192.168.0.60,voice.local" npm run gen-cert
 *
 * É self-signed: cada pessoa aceita o aviso do navegador uma vez.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { config } from '../config/index.js';

const { dir, certPath, keyPath } = config.tls;

fs.mkdirSync(dir, { recursive: true });

const hosts = new Set(['localhost']);
const ips = new Set(['127.0.0.1', '::1']);

if (config.http.lanIp) ips.add(config.http.lanIp);

const isIp = (h) => /^[0-9.]+$/.test(h) || h.includes(':');
for (const raw of (process.env.CERT_HOSTS || '').split(',')) {
  const h = raw.trim();
  if (!h) continue;
  (isIp(h) ? ips : hosts).add(h);
}

const san = [
  ...[...hosts].map((h) => `DNS:${h}`),
  ...[...ips].map((ip) => `IP:${ip}`),
].join(',');

console.log(`Gerando certificado self-signed em ${dir}`);
console.log(`  SAN: ${san}`);

execFileSync(
  'openssl',
  [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath,
    '-out', certPath,
    // 825 dias: limite aceito pela maioria dos navegadores para certs TLS.
    '-days', '825',
    '-subj', '/CN=LAN Voice Chat',
    '-addext', `subjectAltName=${san}`,
  ],
  { stdio: 'inherit' }
);

// A chave privada não deve ficar legível por outros usuários.
fs.chmodSync(keyPath, 0o600);

console.log('');
console.log('✅ Certificado gerado. Reinicie o servidor (npm start) para servir por HTTPS.');
console.log(`   cert: ${certPath}`);
console.log(`   key:  ${keyPath}`);
