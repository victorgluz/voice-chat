import { getState } from '../state.js';
import { voiceClient } from '../voice/voice-client.js';
import { el } from '../util/dom.js';
import { icon, setIcon } from '../util/icons.js';
import { showError } from './dialog.js';

/**
 * Grade de webcams na área central. Quando há câmeras ligadas (a sua ou de
 * outros), um botão no cabeçalho alterna entre o chat e a grade de vídeo.
 * As câmeras são auto-consumidas pelo voiceClient (todos veem).
 *
 * A grade é RECONCILIADA (não recriada) a cada render: os elementos <video>
 * persistem entre renders, senão o vídeo piscaria preto toda vez que o estado
 * muda (ex.: indicador de "falando", que dispara o tempo todo na call).
 */

let videoView = false; // false = chat, true = grade de vídeo
const tiles = new Map(); // key ('self' | peerId) -> { tileEl, videoEl, nameEl, stream }

export function initVideoGrid() {
  const btnCam = document.getElementById('btn-cam');
  const toggle = document.getElementById('btn-view-toggle');

  btnCam.addEventListener('click', async () => {
    try {
      if (voiceClient.camOn) voiceClient.stopWebcam();
      else await voiceClient.startWebcam();
    } catch (err) {
      if (err?.name !== 'NotAllowedError' && err?.name !== 'AbortError') {
        showError('Não foi possível ligar a câmera: ' + err.message);
      }
    }
  });

  toggle.addEventListener('click', () => {
    videoView = !videoView;
    renderVideoGrid();
  });

  voiceClient.onCamStateChange = (on) => {
    btnCam.classList.toggle('active', on);
    setIcon(btnCam, on ? 'videoOff' : 'video');
    btnCam.title = on ? 'Desligar câmera' : 'Ligar câmera';
    // Ao ligar a própria câmera, já leva para a visão de vídeo.
    if (on) videoView = true;
    renderVideoGrid();
  };

  voiceClient.onWebcamsChange = renderVideoGrid;
}

/** Atualiza o botão de alternância, a visão atual e reconcilia os tiles. */
export function renderVideoGrid() {
  const toggle = document.getElementById('btn-view-toggle');
  if (!toggle) return;

  const count = videoCount();
  if (count === 0) {
    videoView = false;
    toggle.classList.add('hidden');
  } else {
    toggle.classList.remove('hidden');
    toggle.replaceChildren(
      icon(videoView ? 'chat' : 'video', 'icon'),
      document.createTextNode(videoView ? ' Chat' : ` Vídeo (${count})`)
    );
  }

  applyView();
  reconcileTiles();
}

function videoCount() {
  return voiceClient.webcams.size + (voiceClient.camOn ? 1 : 0);
}

/** Mostra a grade de vídeo ou o chat conforme o estado atual. */
function applyView() {
  const stage = document.getElementById('video-stage');
  const messages = document.getElementById('messages');
  const composer = document.getElementById('composer');
  const reply = document.getElementById('reply-banner');
  if (!stage) return;

  stage.classList.toggle('hidden', !videoView);
  messages.classList.toggle('hidden', videoView);
  if (composer) composer.classList.toggle('hidden', videoView);
  if (reply && videoView) reply.classList.add('hidden');
}

/**
 * Reconcilia os tiles com o conjunto atual de webcams, preservando os <video>
 * já existentes (sem recriar → sem piscar). Adiciona novos, remove os que
 * saíram e só troca o srcObject quando o stream de fato muda.
 */
function reconcileTiles() {
  const stage = document.getElementById('video-stage');
  if (!stage) return;

  const desired = new Map(); // key -> { stream, name, isSelf }
  const { me } = getState();
  if (voiceClient.camOn && voiceClient.webcamStream) {
    desired.set('self', {
      stream: voiceClient.webcamStream,
      name: `${me?.name || 'Você'} (você)`,
      isSelf: true,
    });
  }
  for (const [peerId, { stream }] of voiceClient.webcams) {
    desired.set(peerId, { stream, name: peerName(peerId), isSelf: false });
  }

  // Remove tiles que não existem mais.
  for (const [key, t] of tiles) {
    if (!desired.has(key)) {
      t.videoEl.srcObject = null;
      t.tileEl.remove();
      tiles.delete(key);
    }
  }

  // Adiciona/atualiza.
  for (const [key, d] of desired) {
    let t = tiles.get(key);
    if (!t) {
      t = createTile(d.isSelf);
      tiles.set(key, t);
      stage.append(t.tileEl);
    }
    if (t.stream !== d.stream) {
      t.videoEl.srcObject = d.stream;
      t.stream = d.stream;
      t.videoEl.play?.().catch(() => {});
    }
    if (t.nameEl.textContent !== d.name) t.nameEl.textContent = d.name;
  }
}

function createTile(isSelf) {
  const videoEl = el('video', { class: `video-el${isSelf ? ' mirror' : ''}` });
  videoEl.autoplay = true;
  videoEl.playsInline = true;
  videoEl.muted = true; // webcam não carrega áudio; o som da call vem pelo mic
  const nameEl = el('span', { class: 'video-name' });
  const tileEl = el('div', { class: 'video-tile' }, [videoEl, nameEl]);
  return { tileEl, videoEl, nameEl, stream: null };
}

function peerName(peerId) {
  const p = getState().presence.find((x) => x.socketId === peerId);
  return p?.user?.name || 'alguém';
}
