import { escapeHtml } from './dom.js';

/**
 * Markdown básico e SEGURO. A ordem é essencial: primeiro escapamos todo o
 * HTML (impede injeção), só então aplicamos as marcações sobre o texto já
 * neutralizado. Nunca inserimos HTML vindo cru do usuário.
 */
export function renderMarkdown(text) {
  let html = escapeHtml(text);

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

  return html;
}
