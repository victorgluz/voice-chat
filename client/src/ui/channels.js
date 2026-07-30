import { getState, presenceInVoice } from '../state.js';
import { request } from '../socket.js';
import { el, clear, initials } from '../util/dom.js';
import { icon } from '../util/icons.js';
import { openUserVolumeMenu } from './user-volume-menu.js';
import { voiceClient } from '../voice/voice-client.js';
import { showError } from './dialog.js';

/** Renderiza a lista de canais de texto e voz no sidebar central. */
export function renderChannels({ onSelectText, onJoinVoice }) {
  const container = clear(document.getElementById('channel-list'));
  const { channels, activeTextChannel, me } = getState();

  container.append(
    section('Canais de texto', 'text', channels.text, (channel) =>
      channelRow(channel, {
        active: channel.id === activeTextChannel,
        onClick: () => onSelectText(channel.id),
      })
    )
  );

  container.append(
    section('Canais de voz', 'voice', channels.voice, (channel) =>
      voiceChannelBlock(channel, onJoinVoice)
    )
  );

  function section(title, type, list, renderItem) {
    const header = el('div', { class: 'channel-section-header' }, [
      el('span', {}, title),
      me?.isAdmin
        ? el('button', {
            class: 'icon-btn',
            title: `Criar canal de ${type === 'voice' ? 'voz' : 'texto'}`,
            onClick: () => createChannel(type),
          }, icon('plus'))
        : null,
    ]);
    return el('div', { class: 'channel-section' }, [header, ...list.map(renderItem)]);
  }

  function channelRow(channel, { active, onClick }) {
    return el('div', { class: `channel-row${active ? ' active' : ''}`, onClick }, [
      el('span', { class: 'channel-icon' }, channel.icon),
      el('span', { class: 'channel-name' }, channel.name),
      me?.isAdmin ? deleteBtn(channel.type, channel.id) : null,
    ]);
  }

  function voiceChannelBlock(channel, onJoin) {
    const members = presenceInVoice(channel.id);
    const row = el('div', { class: 'channel-row', onClick: () => onJoin(channel.id) }, [
      el('span', { class: 'channel-icon' }, channel.icon),
      el('span', { class: 'channel-name' }, channel.name),
      members.length ? el('span', { class: 'voice-count' }, String(members.length)) : null,
      me?.isAdmin ? deleteBtn('voice', channel.id) : null,
    ]);

    const memberList = el(
      'div',
      { class: 'voice-members' },
      members.map((p) =>
        el(
          'div',
          {
            class: `voice-member${p.voice.speaking ? ' speaking' : ''}`,
            onContextmenu: p.user.id === me?.id ? undefined : (e) => openUserVolumeMenu(e, p),
          },
          [
            avatar(p.user),
            el('span', { class: 'voice-member-name' }, p.user.name),
            p.voice.muted ? el('span', { class: 'mini-icon', title: 'Mutado' }, icon('micOff')) : null,
            p.voice.sharing ? sharingBtn(p) : null,
          ]
        )
      )
    );

    return el('div', {}, [row, memberList]);
  }

  function deleteBtn(type, id) {
    return el('button', {
      class: 'icon-btn delete',
      title: 'Apagar canal',
      onClick: (e) => {
        e.stopPropagation();
        if (confirm('Apagar este canal?')) request('admin:deleteChannel', { type, id }).catch(alertErr);
      },
    }, icon('close'));
  }

  function avatar(user) {
    const node = el('div', { class: 'avatar avatar-sm' });
    if (user.avatar?.startsWith('/uploads/')) node.style.backgroundImage = `url(${user.avatar})`;
    else node.textContent = user.avatar || initials(user.name);
    return node;
  }

  // Ícone de "compartilhando": clicar assiste (ou fecha) a tela dessa pessoa.
  function sharingBtn(p) {
    const isSelf = p.user.id === me?.id;
    const watching = voiceClient.watching?.peerId === p.socketId;
    return el(
      'button',
      {
        class: `mini-icon sharing${watching ? ' active' : ''}`,
        title: isSelf ? 'Você está compartilhando' : watching ? 'Parar de assistir' : 'Assistir à tela',
        onClick: (e) => {
          e.stopPropagation();
          if (isSelf) return;
          if (watching) voiceClient.stopWatching();
          else voiceClient.watchScreen(p.socketId).catch((err) => showError(err.message));
        },
      },
      icon('screen')
    );
  }
}

async function createChannel(type) {
  const name = prompt(`Nome do novo canal de ${type === 'voice' ? 'voz' : 'texto'}:`);
  if (!name) return;
  try {
    await request('admin:createChannel', { type, name });
  } catch (err) {
    alertErr(err);
  }
}

function alertErr(err) {
  showError(err.message || String(err));
}
