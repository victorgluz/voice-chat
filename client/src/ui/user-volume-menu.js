import { el } from '../util/dom.js';
import { voiceClient } from '../voice/voice-client.js';

/**
 * Menu de contexto (botão direito sobre um usuário) para regular, só para você,
 * o volume da VOZ e dos EFEITOS SONOROS (soundboard) daquela pessoa. As duas
 * são keyed por socketId (peerId), a mesma identidade dos streams de voz.
 */
let menuEl = null;

export function openUserVolumeMenu(event, presence) {
  event.preventDefault();
  event.stopPropagation();
  closeUserVolumeMenu();

  const peerId = presence.socketId;
  const name = presence.user?.name || 'Usuário';

  menuEl = el('div', { class: 'volume-menu' }, [
    el('div', { class: 'volume-menu-title' }, name),
    volumeRow('Voz', voiceClient.getPeerVolume(peerId), (v) => voiceClient.setPeerVolume(peerId, v)),
    volumeRow('Efeitos', voiceClient.getPeerEffectsVolume(peerId), (v) =>
      voiceClient.setPeerEffectsVolume(peerId, v)
    ),
  ]);
  document.body.append(menuEl);

  // Mantém o menu dentro da viewport.
  const rect = menuEl.getBoundingClientRect();
  const x = Math.min(event.clientX, window.innerWidth - rect.width - 8);
  const y = Math.min(event.clientY, window.innerHeight - rect.height - 8);
  menuEl.style.left = `${Math.max(8, x)}px`;
  menuEl.style.top = `${Math.max(8, y)}px`;

  // Fecha ao clicar fora ou apertar Esc (no próximo tick, para não capturar este clique).
  setTimeout(() => {
    window.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('keydown', onKey, true);
  }, 0);
}

export function closeUserVolumeMenu() {
  if (!menuEl) return;
  menuEl.remove();
  menuEl = null;
  window.removeEventListener('pointerdown', onOutside, true);
  window.removeEventListener('keydown', onKey, true);
}

function volumeRow(label, value, onInput) {
  const pct = Math.round((value ?? 1) * 100);
  const valLabel = el('span', { class: 'volume-val' }, `${pct}%`);
  const slider = el('input', {
    type: 'range',
    min: '0',
    max: '100',
    value: String(pct),
    class: 'volume-slider',
  });
  slider.addEventListener('input', () => {
    const p = Number(slider.value);
    valLabel.textContent = `${p}%`;
    onInput(p / 100);
  });
  return el('div', { class: 'volume-row' }, [
    el('span', { class: 'volume-label' }, label),
    slider,
    valLabel,
  ]);
}

function onOutside(e) {
  if (menuEl && !menuEl.contains(e.target)) closeUserVolumeMenu();
}

function onKey(e) {
  if (e.key === 'Escape') closeUserVolumeMenu();
}
