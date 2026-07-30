import { getState } from '../state.js';
import { request } from '../socket.js';
import { el, clear, initials } from '../util/dom.js';
import { icon } from '../util/icons.js';
import { openUserVolumeMenu } from './user-volume-menu.js';
import { showError } from './dialog.js';

/** Coluna direita: todos os usuários cadastrados — online no topo, offline embaixo. */
export function renderUsers() {
  const container = clear(document.getElementById('members'));
  const { presence, users, channels, me } = getState();

  const voiceName = (id) => channels.voice.find((c) => c.id === id)?.name;

  // Presença por usuário (dedup por id, caso haja múltiplas abas).
  const presByUser = new Map();
  for (const p of presence) if (!presByUser.has(p.user.id)) presByUser.set(p.user.id, p);

  const online = [];
  const offline = [];
  for (const u of users) (presByUser.has(u.id) ? online : offline).push(u);
  online.sort((a, b) => a.name.localeCompare(b.name));
  offline.sort((a, b) => a.name.localeCompare(b.name));

  container.append(el('div', { class: 'members-header' }, `Online — ${online.length}`));
  for (const u of online) container.append(onlineRow(presByUser.get(u.id)));

  if (offline.length) {
    container.append(el('div', { class: 'members-header' }, `Offline — ${offline.length}`));
    for (const u of offline) container.append(offlineRow(u));
  }

  function onlineRow(p) {
    const isSelf = p.user.id === me?.id;
    const row = el('div', { class: `member${p.voice.speaking ? ' speaking' : ''}` }, [
      avatar(p.user),
      el('div', { class: 'member-info' }, [
        el('div', { class: 'member-name' }, [
          p.user.name,
          p.user.isAdmin ? el('span', { class: 'badge', title: 'Administrador' }, 'ADMIN') : null,
        ]),
        el(
          'div',
          { class: 'member-status' },
          p.voiceChannelId
            ? [icon('volume', 'inline-icon'), ` ${voiceName(p.voiceChannelId) || 'em voz'}`]
            : 'Online'
        ),
      ]),
      p.voice.muted ? el('span', { class: 'mini-icon', title: 'Mutado' }, icon('micOff')) : null,
      p.voice.deaf ? el('span', { class: 'mini-icon', title: 'Ensurdecido' }, icon('headphones')) : null,
      p.voice.sharing ? el('span', { class: 'mini-icon sharing', title: 'Compartilhando a tela' }, icon('screen')) : null,
      p.voice.cam ? el('span', { class: 'mini-icon sharing', title: 'Câmera ligada' }, icon('video')) : null,
      me?.isAdmin && !isSelf ? adminMenu(p) : null,
    ]);
    // Botão direito: ajustar volume de voz/efeitos dessa pessoa (menos você mesmo).
    if (!isSelf) row.addEventListener('contextmenu', (e) => openUserVolumeMenu(e, p));
    return row;
  }

  function offlineRow(u) {
    return el('div', { class: 'member offline' }, [
      avatar(u),
      el('div', { class: 'member-info' }, [
        el('div', { class: 'member-name' }, [
          u.name,
          u.isAdmin ? el('span', { class: 'badge', title: 'Administrador' }, 'ADMIN') : null,
        ]),
        el('div', { class: 'member-status' }, 'Offline'),
      ]),
    ]);
  }

  function adminMenu(p) {
    return el('div', { class: 'admin-actions' }, [
      el('button', {
        class: 'icon-btn', title: 'Silenciar',
        onClick: () => call('admin:silenceUser', { socketId: p.socketId, muted: !p.voice.muted }),
      }, icon('micOff')),
      el('button', {
        class: 'icon-btn', title: 'Mover para canal de voz',
        onClick: () => moveUser(p),
      }, icon('move')),
      el('button', {
        class: 'icon-btn danger', title: 'Expulsar',
        onClick: () => {
          if (confirm(`Expulsar ${p.user.name}?`)) call('admin:kickUser', { socketId: p.socketId });
        },
      }, icon('userX')),
    ]);
  }

  function moveUser(p) {
    const { channels } = getState();
    const options = channels.voice.map((c, i) => `${i + 1}. ${c.name}`).join('\n');
    const choice = prompt(`Mover ${p.user.name} para qual canal?\n${options}`);
    const idx = Number(choice) - 1;
    const channel = channels.voice[idx];
    if (channel) call('admin:moveUser', { socketId: p.socketId, channelId: channel.id });
  }

  function avatar(user) {
    const node = el('div', { class: 'avatar avatar-sm' });
    if (user.avatar?.startsWith('/uploads/')) node.style.backgroundImage = `url(${user.avatar})`;
    else node.textContent = user.avatar || initials(user.name);
    return node;
  }
}

function call(event, payload) {
  request(event, payload).catch((err) => showError(err.message));
}
