import { el } from '../util/dom.js';
import { icon } from '../util/icons.js';

/**
 * Diálogos modais reutilizáveis (substituem os alert() do navegador).
 * Reaproveitam as classes .modal-overlay/.modal-card já existentes.
 */

/** Mostra um erro numa modal. */
export function showError(message, title = 'Ops!') {
  showDialog({ title, message, variant: 'error' });
}

/** Mostra um aviso/informação numa modal. */
export function showInfo(message, title = 'Aviso', opts = {}) {
  showDialog({ title, message, variant: 'info', ...opts });
}

/**
 * Modal genérica com um botão OK. `onClose` roda ao fechar (OK, backdrop ou Esc).
 */
export function showDialog({ title, message, variant = 'info', onClose } = {}) {
  // Só uma modal por vez.
  document.getElementById('app-dialog')?.remove();

  const okBtn = el('button', { class: 'btn-secondary', onClick: close }, 'OK');
  const overlay = el('div', { id: 'app-dialog', class: 'modal-overlay' }, [
    el('div', { class: `modal-card dialog-card ${variant}` }, [
      el('div', { class: 'dialog-head' }, [
        el('span', { class: `dialog-icon ${variant}` }, icon(variant === 'error' ? 'close' : 'activity')),
        el('h2', {}, title),
      ]),
      el('p', { class: 'dialog-message' }, message),
      el('div', { class: 'dialog-actions' }, [okBtn]),
    ]),
  ]);

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  }
  function onKey(e) {
    if (e.key === 'Escape' || e.key === 'Enter') close();
  }

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  okBtn.focus();
}
