import { getState } from '../state.js';
import { request } from '../socket.js';
import { el, clear, initials } from '../util/dom.js';
import { icon } from '../util/icons.js';

/** Coluna direita: quem está online, status e canal de voz atual. */
export function renderUsers() {
  const container = clear(document.getElementById('members'));
  const { presence, channels, me } = getState();

  const voiceName = (id) => channels.voice.find((c) => c.id === id)?.name;

  container.append(el('div', { class: 'members-header' }, `Online — ${presence.length}`));

  for (const p of presence) {
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
      me?.isAdmin && !isSelf ? adminMenu(p) : null,
    ]);
    container.append(row);
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
  request(event, payload).catch((err) => alert(err.message));
}
