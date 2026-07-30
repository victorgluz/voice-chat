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

/**
 * Modal de confirmação (Cancelar/Confirmar). Resolve `true` se confirmado,
 * `false` se cancelado (backdrop, Esc ou botão Cancelar).
 */
export function showConfirm({ title = 'Confirmar', message, confirmLabel = 'Confirmar', cancelLabel = 'Cancelar', danger = false } = {}) {
  return new Promise((resolve) => {
    document.getElementById('app-dialog')?.remove();
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };

    const cancelBtn = el('button', { class: 'btn-secondary', onClick: () => finish(false) }, cancelLabel);
    const confirmBtn = el(
      'button',
      { class: `btn-secondary${danger ? ' danger' : ''}`, onClick: () => finish(true) },
      confirmLabel
    );
    const overlay = el('div', { id: 'app-dialog', class: 'modal-overlay' }, [
      el('div', { class: 'modal-card dialog-card info' }, [
        el('div', { class: 'dialog-head' }, [el('h2', {}, title)]),
        el('p', { class: 'dialog-message' }, message),
        el('div', { class: 'dialog-actions' }, [cancelBtn, confirmBtn]),
      ]),
    ]);

    function onKey(e) {
      if (e.key === 'Escape') finish(false);
    }

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(false);
    });
    document.addEventListener('keydown', onKey);
    document.body.append(overlay);
    confirmBtn.focus();
  });
}
