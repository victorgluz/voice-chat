// Autenticação básica sem dependências externas (só node:crypto).
//  - Senhas: scrypt com salt aleatório por usuário.
//  - Tokens: assinatura HMAC-SHA256 estilo JWT compacto (header omitido).
// O segredo é gerado uma vez e guardado em settings; assim os tokens
// sobrevivem a reinícios do servidor (o usuário não precisa relogar).

import {
  scryptSync,
  randomBytes,
  timingSafeEqual,
  createHmac,
} from 'node:crypto';
import { getSetting, setSetting } from '../database/repositories/settings.js';

const SCRYPT_KEYLEN = 64;

/** Gera "scrypt$<saltHex>$<hashHex>" a partir da senha em texto puro. */
export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** Confere a senha contra o valor armazenado, resistente a timing attacks. */
export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Segredo HMAC persistido em settings; criado sob demanda na 1ª vez. */
function getSecret() {
  let secret = getSetting('auth_secret');
  if (!secret) {
    secret = randomBytes(32).toString('hex');
    setSetting('auth_secret', secret);
  }
  return secret;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function sign(data) {
  return createHmac('sha256', getSecret()).update(data).digest('base64url');
}

/** Assina um token contendo o id do usuário. Sem expiração: uso em LAN. */
export function signToken(userId) {
  const payload = b64url(JSON.stringify({ uid: userId, iat: Date.now() }));
  return `${payload}.${sign(payload)}`;
}

/** Verifica a assinatura e devolve o payload { uid, iat } ou null. */
export function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
