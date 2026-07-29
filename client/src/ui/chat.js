import { getState, setState } from '../state.js';
import { request } from '../socket.js';
import { el, clear, initials, formatTime } from '../util/dom.js';
import { renderMarkdown } from '../util/markdown.js';
import { icon } from '../util/icons.js';

let pendingAttachment = null;
const loaded = new Map(); // id -> message (para resolver respostas)

export function initChat() {
  const form = document.getElementById('composer');
  const input = document.getElementById('composer-input');
  const attachInput = document.getElementById('attach-input');
  const attachBtn = document.getElementById('attach-btn');

  attachBtn.addEventListener('click', () => attachInput.click());
  attachInput.addEventListener('change', () => handleAttach(attachInput.files?.[0]));

  document.getElementById('reply-cancel').addEventListener('click', cancelReply);
  document.getElementById('attach-remove').addEventListener('click', clearAttachment);

  // Enter envia; Shift+Enter quebra linha.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
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
      alert(err.message);
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
    contentNode(msg),
    msg.attachment ? attachmentNode(msg.attachment) : null,
  ]);

  const actions = el('div', { class: 'message-actions' }, [
    el('button', { class: 'icon-btn', title: 'Responder', onClick: () => startReply(msg) }, icon('reply')),
    canEdit ? el('button', { class: 'icon-btn', title: 'Editar', onClick: () => startEdit(msg) }, icon('edit')) : null,
    canModify
      ? el('button', {
          class: 'icon-btn danger', title: 'Apagar',
          onClick: () => request('chat:delete', { id: msg.id }).catch((e) => alert(e.message)),
        }, icon('trash'))
      : null,
  ]);

  return el('div', { class: 'message', dataset: { id: msg.id } }, [avatarNode(msg.author), body, actions]);
}

function contentNode(msg) {
  return el('div', { class: 'message-content', html: renderMarkdown(msg.content) });
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
        alert(err.message);
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

async function handleAttach(file) {
  if (!file) return;
  const body = new FormData();
  body.append('file', file);
  try {
    const res = await fetch('/api/upload', { method: 'POST', body });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error);
    pendingAttachment = json;
    showAttachmentChip(json.name);
  } catch (err) {
    alert(err.message);
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

export { cancelReply, clearAttachment };
