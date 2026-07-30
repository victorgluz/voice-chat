import { getState, setState } from '../state.js';
import { request } from '../socket.js';
import { el, clear, initials, formatTime } from '../util/dom.js';
import { renderMarkdown } from '../util/markdown.js';
import { icon } from '../util/icons.js';
import { showError } from './dialog.js';

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

  // Autocomplete de @menção. Registrado ANTES do Enter-envia para interceptar
  // as teclas quando a lista está aberta.
  initMentionAutocomplete(form, input);

  // Enter envia; Shift+Enter quebra linha. Seta pra cima (campo vazio) edita a
  // última mensagem que enviei no canal.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
      return;
    }
    if (e.key === 'ArrowUp' && !input.value && input.selectionStart === 0) {
      if (editLastOwnMessage()) e.preventDefault();
    }
  });

  // Colar arquivo (imagem, pdf, mp3, doc…) direto no chat: vira anexo.
  input.addEventListener('paste', (e) => {
    const cd = e.clipboardData;
    if (!cd) return;

    const fileItem = [...(cd.items || [])].find((it) => it.kind === 'file');
    if (!fileItem) return; // sem arquivo no clipboard → paste normal (texto)

    e.preventDefault();
    const file = fileItem.getAsFile();
    if (!file) return;

    // Imagem da web: o navegador coloca um PNG estático (perde o GIF), mas
    // também a URL de origem. Se houver URL, baixamos o ORIGINAL (GIF animado)
    // pelo servidor; senão, usamos o próprio arquivo colado.
    if (file.type.startsWith('image/')) {
      const url = imageUrlFromClipboard(cd);
      if (url) {
        handleAttachFromUrl(url, file);
        return;
      }
    }
    const named = file.name && /\.[a-z0-9]+$/i.test(file.name)
      ? file.name
      : `colado.${extForMime(file.type)}`;
    handleAttach(file, named);
  });

  // Arrastar-e-soltar arquivo em qualquer lugar do app.
  initDropZone();

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
      const node = renderMessage(msg);
      if (node) list.append(node);
    }
    scrollToBottom();
  } catch (err) {
    list.append(el('div', { class: 'chat-error' }, err.message));
  }
}

export function appendMessage(msg) {
  loaded.set(msg.id, msg);
  if (msg.channelId !== getState().activeTextChannel) return;
  const node = renderMessage(msg);
  if (!node) return;
  const list = document.getElementById('messages');
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
  list.append(node);
  if (nearBottom) scrollToBottom();
}

export function updateMessage(msg) {
  loaded.set(msg.id, msg);
  const existing = document.querySelector(`.message[data-id="${msg.id}"]`);
  if (!existing) return;
  const node = renderMessage(msg);
  node ? existing.replaceWith(node) : existing.remove();
}

export function removeMessage(id) {
  const msg = loaded.get(id);
  if (msg) msg.deleted = true;
  document.querySelector(`.message[data-id="${id}"]`)?.remove();
}

// ---- render ----

function renderMessage(msg) {
  // Mensagem apagada não é exibida (nem placeholder).
  if (msg.deleted) return null;

  const { me } = getState();
  const canModify = me && (msg.userId === me.id || me.isAdmin);
  const canEdit = me && msg.userId === me.id;

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
  const mime = att.mime || '';

  // Imagem: miniatura que abre no lightbox.
  if (mime.startsWith('image/')) {
    return el(
      'button',
      {
        class: 'attachment-image-btn',
        title: att.name || 'Abrir imagem',
        onClick: () => openLightbox(att.url, att.name),
      },
      [el('img', { class: 'attachment-image', src: att.url, alt: att.name })]
    );
  }

  // Áudio: player embutido (toca no app).
  if (mime.startsWith('audio/')) {
    return el('div', { class: 'attachment-card attachment-audio' }, [
      el('audio', { controls: '', preload: 'metadata', src: att.url }),
      metaRow(att, [downloadBtn(att)]),
    ]);
  }

  // Vídeo: player embutido.
  if (mime.startsWith('video/')) {
    return el('div', { class: 'attachment-card attachment-video' }, [
      el('video', { class: 'attachment-video-el', controls: '', preload: 'metadata', src: att.url }),
      metaRow(att, [downloadBtn(att)]),
    ]);
  }

  // PDF: card com Abrir (modal) + Baixar.
  if (mime === 'application/pdf') {
    return el('div', { class: 'attachment-card' }, [
      fileRow(att, [
        el('button', { class: 'btn-attach', onClick: () => openPdf(att.url, att.name) }, 'Abrir'),
        downloadBtn(att),
      ]),
    ]);
  }

  // Demais tipos: card só com Baixar (sem preview embutido no navegador).
  return el('div', { class: 'attachment-card' }, [fileRow(att, [downloadBtn(att)])]);
}

/** Linha "ícone + nome/tamanho + ações" para PDFs e arquivos genéricos. */
function fileRow(att, actions) {
  return el('div', { class: 'attachment-file-row' }, [
    el('span', { class: 'attachment-icon' }, icon('file')),
    fileInfo(att),
    el('div', { class: 'attachment-actions' }, actions),
  ]);
}

/** Linha "nome/tamanho + ações" para os cards de mídia (áudio/vídeo). */
function metaRow(att, actions) {
  return el('div', { class: 'attachment-meta-row' }, [
    fileInfo(att),
    el('div', { class: 'attachment-actions' }, actions),
  ]);
}

function fileInfo(att) {
  return el('div', { class: 'attachment-info' }, [
    el('div', { class: 'attachment-name' }, att.name || 'arquivo'),
    att.size ? el('div', { class: 'attachment-size' }, formatBytes(att.size)) : null,
  ]);
}

/** Link de download (o atributo `download` força baixar em vez de navegar). */
function downloadBtn(att) {
  return el(
    'a',
    { class: 'btn-attach btn-download', href: att.url, download: att.name || '', title: 'Baixar' },
    [icon('download'), ' Baixar']
  );
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i > 0 && v < 10 ? 1 : 0)} ${units[i]}`;
}

/** PDF em overlay (iframe) dentro do app. Fecha no fundo, ✕ ou Esc. */
function openPdf(url, name) {
  document.getElementById('pdf-viewer')?.remove();

  const overlay = el(
    'div',
    {
      id: 'pdf-viewer',
      class: 'pdf-overlay',
      onClick: (e) => {
        if (e.target === overlay) close();
      },
    },
    [
      el('div', { class: 'pdf-head' }, [
        el('span', { class: 'pdf-title' }, name || 'PDF'),
        el('div', { class: 'pdf-actions' }, [
          el(
            'a',
            { class: 'btn-attach btn-download', href: url, download: name || '', title: 'Baixar' },
            [icon('download'), ' Baixar']
          ),
          el('button', { class: 'icon-btn', title: 'Fechar', onClick: close }, icon('close')),
        ]),
      ]),
      el('iframe', { class: 'pdf-frame', src: url, title: name || 'PDF' }),
    ]
  );

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
  }

  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
}

function avatarNode(user) {
  const node = el('div', { class: 'message-avatar' });
  if (user.avatar?.startsWith('/uploads/')) node.style.backgroundImage = `url(${user.avatar})`;
  else node.textContent = user.avatar || initials(user.name);
  return node;
}

/** Lightbox: abre a imagem em tela cheia sobre o app (fecha no fundo, X ou Esc). */
function openLightbox(url, name) {
  document.getElementById('image-lightbox')?.remove();

  const overlay = el(
    'div',
    {
      id: 'image-lightbox',
      class: 'lightbox-overlay',
      onClick: (e) => {
        if (e.target === overlay) close();
      },
    },
    [
      el('img', { class: 'lightbox-img', src: url, alt: name || '' }),
      el('div', { class: 'lightbox-actions' }, [
        el(
          'a',
          { class: 'icon-btn', href: url, download: name || '', title: 'Baixar', onClick: (e) => e.stopPropagation() },
          icon('download')
        ),
        el('button', { class: 'icon-btn', title: 'Fechar', onClick: close }, icon('close')),
      ]),
    ]
  );

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
  }

  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
}

// ---- edição inline ----

/** Edita a última mensagem de texto que EU enviei no canal ativo. */
function editLastOwnMessage() {
  const { me, activeTextChannel } = getState();
  if (!me) return false;
  let last = null;
  for (const msg of loaded.values()) {
    if (msg.deleted || msg.userId !== me.id || msg.channelId !== activeTextChannel) continue;
    if (!msg.content) continue; // sem texto (ex.: só imagem) não dá pra editar
    if (!last || msg.createdAt > last.createdAt) last = msg;
  }
  if (!last) return false;
  startEdit(last);
  return true;
}

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

let previewUrl = null; // object URL do preview local (revogado ao trocar/limpar)

/** Extrai a URL de imagem de origem do clipboard (text/html ou uri-list). */
function imageUrlFromClipboard(cd) {
  const html = cd.getData('text/html');
  if (html) {
    const img = new DOMParser().parseFromString(html, 'text/html').querySelector('img');
    if (img?.src && /^https?:\/\//i.test(img.src)) return img.src;
  }
  const uri = (cd.getData('text/uri-list') || '').trim();
  if (/^https?:\/\/\S+$/i.test(uri)) return uri;
  return null;
}

/**
 * Baixa uma imagem por URL (via servidor) e usa como anexo — preserva GIF
 * animado. Em caso de falha, cai para o arquivo colado (PNG estático), se houver.
 */
async function handleAttachFromUrl(url, fallbackFile) {
  revokePreview();
  showAttachmentChip('imagem…', url); // preview instantâneo com a própria URL
  try {
    const res = await fetch('/api/upload/url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Falha ao baixar a imagem.');
    pendingAttachment = json;
    showAttachmentChip(json.name || 'imagem', json.mime?.startsWith('image/') ? json.url : null);
    document.getElementById('composer-input').focus();
  } catch (err) {
    if (fallbackFile) {
      const named = fallbackFile.name && /\.[a-z0-9]+$/i.test(fallbackFile.name)
        ? fallbackFile.name
        : `colado.${extForMime(fallbackFile.type)}`;
      return handleAttach(fallbackFile, named);
    }
    showError(err.message);
    clearAttachment();
  }
}

async function handleAttach(file, filename) {
  if (!file) return;
  const isImage = file.type?.startsWith('image/');

  // Preview instantâneo a partir do arquivo local (antes mesmo do upload).
  revokePreview();
  if (isImage) previewUrl = URL.createObjectURL(file);
  showAttachmentChip(filename || file.name || 'arquivo', isImage ? previewUrl : null);

  const body = new FormData();
  body.append('file', file, filename || file.name || 'arquivo');
  try {
    const res = await fetch('/api/upload', { method: 'POST', body });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Falha no upload.');
    pendingAttachment = json;
    // Após o upload, mantém a mesma miniatura (o preview local já basta).
    showAttachmentChip(json.name || 'arquivo', isImage ? previewUrl : null);
    // Foca o campo para que Enter envie mesmo sem digitar texto.
    document.getElementById('composer-input').focus();
  } catch (err) {
    showError(err.message);
    clearAttachment();
  }
}

function showAttachmentChip(name, imageUrl = null) {
  const chip = document.getElementById('attach-chip');
  const thumb = document.getElementById('attach-thumb');
  chip.classList.remove('hidden');
  chip.querySelector('.attach-name').textContent = name;
  if (imageUrl) {
    thumb.src = imageUrl;
    thumb.classList.remove('hidden');
  } else {
    thumb.removeAttribute('src');
    thumb.classList.add('hidden');
  }
}

function revokePreview() {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
}

function clearAttachment() {
  pendingAttachment = null;
  revokePreview();
  document.getElementById('attach-input').value = '';
  document.getElementById('attach-chip').classList.add('hidden');
}

function scrollToBottom() {
  const list = document.getElementById('messages');
  list.scrollTop = list.scrollHeight;
}

/** Arrastar-e-soltar arquivo em qualquer lugar do app → vira anexo do composer. */
function initDropZone() {
  const overlay = document.getElementById('drop-overlay');
  if (!overlay) return;
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    overlay.classList.remove('hidden');
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // necessário para habilitar o drop
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.classList.add('hidden');
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.classList.add('hidden');
    const files = e.dataTransfer?.files;
    if (!files?.length) return;
    if (files.length > 1) showError('Envie um arquivo por vez — usando o primeiro.');
    handleAttach(files[0]);
  });
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
