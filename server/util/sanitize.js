// Validação/sanitização no servidor. O cliente também escapa na renderização,
// mas a fonte da verdade é aqui: nada é gravado sem passar por estas funções.

const MAX_MESSAGE = 4000;
const MAX_NAME = 32;

// Remove caracteres de controle (U+0000–U+001F, U+007F) preservando
// \t (U+0009), \n (U+000A) e \r (U+000D). Construído via string escapada
// para não embutir bytes de controle no código-fonte.
const CONTROL_CHARS = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]', 'g');

/** Remove caracteres de controle e limita o tamanho. Não escapa HTML: o
 *  armazenamento é texto cru; o escape acontece na renderização do cliente. */
export function cleanText(value, max = MAX_MESSAGE) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_CHARS, '').trim().slice(0, max);
}

export function cleanName(value) {
  const name = cleanText(value, MAX_NAME);
  return name.length >= 1 ? name : null;
}

/** Nome de um som do soundboard: obrigatório, até 48 caracteres. */
export function cleanSoundName(value) {
  const name = cleanText(value, 48);
  return name.length >= 1 ? name : null;
}

/** Aceita apenas nomes de canal simples: letras, números, hífen, underscore. */
export function cleanChannelName(value) {
  const raw = cleanText(value, 48).toLowerCase().replace(/\s+/g, '-');
  const name = raw.replace(/[^a-z0-9\-_À-ÿ]/g, '');
  return name.length >= 1 ? name : null;
}

/** Normaliza e valida um e-mail (formato simples, minúsculo). Retorna null se inválido. */
export function cleanEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase().slice(0, 254);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/** Avatar deve ser uma URL relativa a /uploads ou um emoji curto. */
export function cleanAvatar(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (v.startsWith('/uploads/') && v.length < 256) return v;
  if (/^\p{Emoji}/u.test(v) && v.length <= 8) return v;
  return null;
}

export const limits = { MAX_MESSAGE, MAX_NAME };
