import { escapeHtml } from './dom.js';

/**
 * Markdown básico e SEGURO. A ordem é essencial: primeiro escapamos todo o
 * HTML (impede injeção), só então aplicamos as marcações sobre o texto já
 * neutralizado. Nunca inserimos HTML vindo cru do usuário.
 *
 * `opts.users` (todos os cadastrados) e `opts.meId` habilitam o realce de
 * @menções — o span da menção é guardado como placeholder e só restaurado no
 * fim, para não interferir nas demais regras nem recasar nomes-prefixo.
 */
// Delimitador de placeholder: caractere nulo (não ocorre em mensagens de texto).
const SENTINEL = String.fromCharCode(0);
const RESTORE_RE = new RegExp(SENTINEL + '(\\d+)' + SENTINEL, 'g');

export function renderMarkdown(text, { users = [], meId = null } = {}) {
  let html = escapeHtml(text);

  const tokens = [];
  html = highlightMentions(html, users, meId, tokens);

  // Blocos de código ```...``` primeiro, para não formatar o conteúdo interno.
  html = html.replace(/```([\s\S]*?)```/g, (_m, code) => `<pre><code>${code.trim()}</code></pre>`);

  // Código inline `...`
  html = html.replace(/`([^`\n]+?)`/g, '<code>$1</code>');

  // Negrito, itálico, tachado.
  html = html.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*\n]+?)\*/g, '<em>$1</em>');
  html = html.replace(/__([^_\n]+?)__/g, '<strong>$1</strong>');
  html = html.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');

  // Auto-link de URLs http(s). O href é montado a partir de texto já escapado.
  html = html.replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  // Quebras de linha.
  html = html.replace(/\n/g, '<br>');

  // Restaura os spans de menção guardados como placeholders.
  html = html.replace(RESTORE_RE, (_m, i) => tokens[Number(i)]);

  return html;
}

function highlightMentions(html, users, meId, tokens) {
  if (!users.length) return html;
  const byLongest = [...users].sort((a, b) => b.name.length - a.name.length);
  for (const u of byLongest) {
    const escName = escapeHtml(u.name);
    if (!escName) continue;
    const re = new RegExp('@' + escapeRegExp(escName) + '(?![\\w])', 'g');
    const cls = u.id === meId ? 'mention mention-self' : 'mention';
    html = html.replace(re, () => {
      const idx = tokens.push(`<span class="${cls}">@${escName}</span>`) - 1;
      return SENTINEL + idx + SENTINEL; // sem @, não recasa como prefixo
    });
  }
  return html;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
