import { getState, setState } from '../state.js';
import { request } from '../socket.js';
import { el, clear, initials, formatTime } from '../util/dom.js';
import { renderMarkdown } from '../util/markdown.js';
import { icon } from '../util/icons.js';
import { showError } from './dialog.js';
import { openAttachMenu } from './attach-menu.js';
import { openGamesModal } from './games.js';

let pendingAttachment = null;
const loaded = new Map(); // id -> message (para resolver respostas)

export function initChat() {
  const form = document.getElementById('composer');
  const input = document.getElementById('composer-input');
  const attachInput = document.getElementById('attach-input');
  const attachBtn = document.getElementById('attach-btn');

  attachBtn.addEventListener('click', () =>
    openAttachMenu(attachBtn, {
      onMedia: () => attachInput.click(),
      onGames: () => openGamesModal(),
    })
  );
  attachInput.addEventListener('change', () => handleAttach(attachInput.files?.[0]));

  document.getElementById('reply-cancel').addEventListener('click', cancelReply);
  document.getElementById('attach-remove').addEventListener('click', clearAttachment);

  // Autocomplete de @menção. Registrado ANTES do Enter-envia para interceptar
  // as teclas quando a lista está aberta.
  initMentionAutocomplete(form, input);

  // Enter envia; Shift+Enter quebra linha.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  // Colar imagem (print/copiar imagem) direto no chat: vira anexo.
  input.addEventListener('paste', (e) => {
    for (const item of e.clipboardData?.items || []) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          const named = file.name && /\.[a-z0-9]+$/i.test(file.name)
            ? file.name
            : `colado.${extForMime(file.type)}`;
          handleAttach(file, named);
        }
        return;
      }
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { activeTextChannel, replyingTo } = getState();
    const content = input.value;
    if (!content.trim() && !pendingAttachment) return;
    if (!activeTextChannel) return;

    try {
      await request('chat:send', {
        channelId: activeTextChannel,
        content,
        replyTo: replyingTo?.id || null,
        attachment: pendingAttachment,
      });
      input.value = '';
      clearAttachment();
      cancelReply();
    } catch (err) {
      showError(err.message);
    }
  });
}

export async function setActiveChannel(channelId) {
  setState({ activeTextChannel: channelId });
  cancelReply();
  const channel = getState().channels.text.find((c) => c.id === channelId);
  document.getElementById('chat-title').textContent = channel ? `${channel.icon} ${channel.name}` : '';
  document.getElementById('composer-input').placeholder = channel
    ? `Conversar em #${channel.name}`
    : '';

  const list = clear(document.getElementById('messages'));
  loaded.clear();
  try {
    const history = await request('chat:history', { channelId });
    for (const msg of history) {
      loaded.set(msg.id, msg);
      list.append(renderMessage(msg));
    }
    scrollToBottom();
  } catch (err) {
    list.append(el('div', { class: 'chat-error' }, err.message));
  }
}

export function appendMessage(msg) {
  loaded.set(msg.id, msg);
  if (msg.channelId !== getState().activeTextChannel) return;
  const list = document.getElementById('messages');
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
  list.append(renderMessage(msg));
  if (nearBottom) scrollToBottom();
}

export function updateMessage(msg) {
  loaded.set(msg.id, msg);
  const existing = document.querySelector(`.message[data-id="${msg.id}"]`);
  if (existing) existing.replaceWith(renderMessage(msg));
}

export function removeMessage(id) {
  const msg = loaded.get(id);
  if (msg) msg.deleted = true;
  const existing = document.querySelector(`.message[data-id="${id}"]`);
  if (existing && msg) existing.replaceWith(renderMessage(msg));
}

// ---- render ----

function renderMessage(msg) {
  const { me } = getState();
  const canModify = me && (msg.userId === me.id || me.isAdmin);
  const canEdit = me && msg.userId === me.id;

  if (msg.deleted) {
    return el('div', { class: 'message deleted', dataset: { id: msg.id } }, [
      el('div', { class: 'message-avatar' }),
      el('div', { class: 'message-body' }, [
        el('div', { class: 'message-content muted' }, 'mensagem apagada'),
      ]),
    ]);
  }

  const body = el('div', { class: 'message-body' }, [
    msg.replyTo ? replyReference(msg.replyTo) : null,
    el('div', { class: 'message-head' }, [
      el('span', { class: 'message-author' }, msg.author.name),
      el('span', { class: 'message-time' }, formatTime(msg.createdAt)),
      msg.editedAt ? el('span', { class: 'message-edited' }, '(editado)') : null,
    ]),
    msg.content ? contentNode(msg) : null,
    msg.attachment ? attachmentNode(msg.attachment) : null,
  ]);

  const actions = el('div', { class: 'message-actions' }, [
    el('button', { class: 'icon-btn', title: 'Responder', onClick: () => startReply(msg) }, icon('reply')),
    canEdit ? el('button', { class: 'icon-btn', title: 'Editar', onClick: () => startEdit(msg) }, icon('edit')) : null,
    canModify
      ? el('button', {
          class: 'icon-btn danger', title: 'Apagar',
          onClick: () => request('chat:delete', { id: msg.id }).catch((e) => showError(e.message)),
        }, icon('trash'))
      : null,
  ]);

  const mentionsMe = me && msg.mentions?.includes(me.id);
  const node = el('div', {
    class: `message${mentionsMe ? ' mentioned' : ''}`,
    dataset: { id: msg.id },
  }, [avatarNode(msg.author), body, actions]);

  // Se é uma menção ainda não lida para mim, observa para marcar lida ao ver.
  if (mentionsMe && getState().mentions.some((m) => m.messageId === msg.id)) {
    getMentionObserver().observe(node);
  }
  return node;
}

// Marca menções como lidas quando as mensagens ficam visíveis na tela.
let mentionObserver = null;
function getMentionObserver() {
  if (mentionObserver) return mentionObserver;
  mentionObserver = new IntersectionObserver(
    (entries) => {
      const seen = [];
      for (const e of entries) {
        if (e.isIntersecting) {
          seen.push(e.target.dataset.id);
          mentionObserver.unobserve(e.target);
        }
      }
      if (seen.length) markMentionsSeen(seen);
    },
    { threshold: 0.05 }
  );
  return mentionObserver;
}

function markMentionsSeen(messageIds) {
  const { mentions } = getState();
  const remaining = mentions.filter((m) => !messageIds.includes(m.messageId));
  if (remaining.length !== mentions.length) {
    setState({ mentions: remaining });
    request('mentions:read', { messageIds }).catch(() => {});
  }
}

function contentNode(msg) {
  const { users, me } = getState();
  return el('div', {
    class: 'message-content',
    html: renderMarkdown(msg.content, { users, meId: me?.id }),
  });
}

function replyReference(replyId) {
  const ref = loaded.get(replyId);
  const text = ref ? `${ref.author.name}: ${ref.content.slice(0, 80)}` : 'mensagem';
  return el('div', { class: 'reply-ref' }, [el('span', {}, '↳ '), el('span', {}, text)]);
}

function attachmentNode(att) {
  if (att.mime?.startsWith('image/')) {
    return el('a', { href: att.url, target: '_blank', rel: 'noopener' }, [
      el('img', { class: 'attachment-image', src: att.url, alt: att.name }),
    ]);
  }
  return el('a', { class: 'attachment-file', href: att.url, target: '_blank', rel: 'noopener' }, [
    el('span', { class: 'attachment-icon' }, icon('paperclip')),
    el('span', {}, att.name),
  ]);
}

function avatarNode(user) {
  const node = el('div', { class: 'message-avatar' });
  if (user.avatar?.startsWith('/uploads/')) node.style.backgroundImage = `url(${user.avatar})`;
  else node.textContent = user.avatar || initials(user.name);
  return node;
}

// ---- edição inline ----

function startEdit(msg) {
  const node = document.querySelector(`.message[data-id="${msg.id}"] .message-content`);
  if (!node) return;
  const textarea = el('textarea', { class: 'edit-box' });
  textarea.value = msg.content;
  node.replaceWith(textarea);
  textarea.focus();

  const save = async () => {
    const content = textarea.value;
    if (content.trim() && content !== msg.content) {
      try {
        await request('chat:edit', { id: msg.id, content });
      } catch (err) {
        showError(err.message);
      }
    }
    updateMessage(loaded.get(msg.id));
  };

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      updateMessage(loaded.get(msg.id));
    }
  });
}

// ---- resposta ----

function startReply(msg) {
  setState({ replyingTo: msg });
  const banner = document.getElementById('reply-banner');
  banner.classList.remove('hidden');
  banner.querySelector('.reply-target').textContent = `Respondendo a ${msg.author.name}`;
  document.getElementById('composer-input').focus();
}

function cancelReply() {
  setState({ replyingTo: null });
  document.getElementById('reply-banner').classList.add('hidden');
}

// ---- anexos ----

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
};

function extForMime(mime) {
  return MIME_EXT[mime] || 'png';
}

async function handleAttach(file, filename) {
  if (!file) return;
  const body = new FormData();
  body.append('file', file, filename || file.name || 'arquivo');
  try {
    const res = await fetch('/api/upload', { method: 'POST', body });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Falha no upload.');
    pendingAttachment = json;
    showAttachmentChip(json.name || 'arquivo');
    // Foca o campo para que Enter envie mesmo sem digitar texto.
    document.getElementById('composer-input').focus();
  } catch (err) {
    showError(err.message);
  }
}

function showAttachmentChip(name) {
  const chip = document.getElementById('attach-chip');
  chip.classList.remove('hidden');
  chip.querySelector('.attach-name').textContent = name;
}

function clearAttachment() {
  pendingAttachment = null;
  document.getElementById('attach-input').value = '';
  document.getElementById('attach-chip').classList.add('hidden');
}

function scrollToBottom() {
  const list = document.getElementById('messages');
  list.scrollTop = list.scrollHeight;
}

/**
 * Autocomplete de @menção no composer: ao digitar "@" + texto, mostra uma lista
 * de usuários cadastrados; setas navegam, Enter/Tab escolhem, Esc fecha.
 * Também aceita @nome digitado direto (a resolução final é feita no servidor).
 */
function initMentionAutocomplete(form, input) {
  const box = el('div', { class: 'mention-autocomplete hidden' });
  form.append(box);

  let items = [];
  let index = 0;
  let start = -1; // posição do "@" no texto

  const open = () => items.length > 0 && !box.classList.contains('hidden');

  function update() {
    const caret = input.selectionStart;
    const m = input.value.slice(0, caret).match(/@([^\s@]*)$/);
    if (!m) return close();
    start = caret - m[0].length;
    const query = m[1].toLowerCase();
    items = getState()
      .users.filter((u) => u.name.toLowerCase().includes(query))
      .slice(0, 8);
    if (!items.length) return close();
    index = 0;
    render();
  }

  function render() {
    clear(box);
    items.forEach((u, i) => {
      box.append(
        el(
          'div',
          {
            class: `mention-ac-item${i === index ? ' active' : ''}`,
            onMousedown: (e) => {
              e.preventDefault(); // não perde o foco do textarea
              pick(u);
            },
          },
          [acAvatar(u), el('span', { class: 'mention-ac-name' }, u.name)]
        )
      );
    });
    box.classList.remove('hidden');
  }

  function pick(u) {
    const caret = input.selectionStart;
    const before = input.value.slice(0, start);
    const after = input.value.slice(caret);
    const insert = `@${u.name} `;
    input.value = before + insert + after;
    const pos = (before + insert).length;
    input.setSelectionRange(pos, pos);
    close();
    input.focus();
  }

  function close() {
    items = [];
    box.classList.add('hidden');
  }

  input.addEventListener('input', update);
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
    if (!open()) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      index = (index + 1) % items.length;
      render();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      index = (index - 1 + items.length) % items.length;
      render();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      e.stopImmediatePropagation(); // impede o Enter-envia
      pick(items[index]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
}

function acAvatar(u) {
  const node = el('div', { class: 'avatar avatar-sm' });
  if (u.avatar?.startsWith('/uploads/')) node.style.backgroundImage = `url(${u.avatar})`;
  else node.textContent = u.avatar || initials(u.name);
  return node;
}

export { cancelReply, clearAttachment };
