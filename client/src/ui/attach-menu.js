import { el } from '../util/dom.js';
import { icon } from '../util/icons.js';

/**
 * Popover do botão "+" do composer: escolher entre anexar mídia/arquivo ou
 * abrir o modal de jogos. Mesmo padrão do menu de volume por usuário
 * (elemento solto no body, posicionado perto do botão, fecha em clique fora
 * ou Esc).
 */
let menuEl = null;

export function openAttachMenu(anchorBtn, { onMedia, onGames }) {
  closeAttachMenu();

  menuEl = el('div', { class: 'attach-menu' }, [
    attachRow('image', 'Mídia', () => {
      closeAttachMenu();
      onMedia();
    }),
    attachRow('gamepad', 'Apps', () => {
      closeAttachMenu();
      onGames();
    }),
  ]);
  document.body.append(menuEl);

  const anchor = anchorBtn.getBoundingClientRect();
  const rect = menuEl.getBoundingClientRect();
  const x = Math.min(anchor.left, window.innerWidth - rect.width - 8);
  const y = Math.max(8, anchor.top - rect.height - 8);
  menuEl.style.left = `${Math.max(8, x)}px`;
  menuEl.style.top = `${y}px`;

  setTimeout(() => {
    window.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('keydown', onKey, true);
  }, 0);
}

export function closeAttachMenu() {
  if (!menuEl) return;
  menuEl.remove();
  menuEl = null;
  window.removeEventListener('pointerdown', onOutside, true);
  window.removeEventListener('keydown', onKey, true);
}

function attachRow(iconName, label, onClick) {
  return el('button', { type: 'button', class: 'attach-menu-row', onClick }, [
    el('span', { class: 'attach-menu-icon' }, icon(iconName)),
    el('span', {}, label),
  ]);
}

function onOutside(e) {
  if (menuEl && !menuEl.contains(e.target)) closeAttachMenu();
}

function onKey(e) {
  if (e.key === 'Escape') closeAttachMenu();
}
