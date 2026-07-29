import { getState } from '../state.js';
import { request } from '../socket.js';
import { el, clear } from '../util/dom.js';
import { icon } from '../util/icons.js';
import { voiceClient } from '../voice/voice-client.js';
import { decodeAudio, createTrimmer, trimToWavBlob, closeAudioContext } from '../util/audio-trim.js';

/**
 * Soundboard: biblioteca global de sons. Qualquer um adiciona; tocar faz o som
 * sair para todos no canal de voz atual (ou preview solo fora de call). Ao
 * adicionar, é possível cortar um trecho do áudio antes de subir (client-side).
 */
export function initSoundboard() {
  const overlay = document.getElementById('soundboard-overlay');
  const openBtn = document.getElementById('btn-soundboard');
  const closeBtn = document.getElementById('soundboard-close');
  const stopBtn = document.getElementById('soundboard-stop');
  const addToggle = document.getElementById('soundboard-add-toggle');
  const grid = document.getElementById('soundboard-grid');
  const form = document.getElementById('soundboard-form');
  const nameInput = document.getElementById('sound-name');
  const audioInput = document.getElementById('sound-audio');
  const trimmerBox = document.getElementById('sound-trimmer');
  const canvas = document.getElementById('sound-waveform');
  const previewBtn = document.getElementById('sound-preview');
  const rangeLabel = document.getElementById('sound-range');
  const submitBtn = document.getElementById('sound-submit');
  const cancelBtn = document.getElementById('sound-cancel');
  const hint = document.getElementById('soundboard-hint');

  // Estado do formulário de adicionar.
  let trimmer = null;
  let decodedBuffer = null;
  let audioFile = null;

  // Dois modos: navegar (lista de sons) ou adicionar (formulário). Ao adicionar
  // não listamos os sons — libera espaço e foca no upload.
  const showBrowse = () => {
    form.classList.add('hidden');
    grid.classList.remove('hidden');
    addToggle.classList.remove('hidden');
  };
  const showAdd = () => {
    grid.classList.add('hidden');
    addToggle.classList.add('hidden');
    form.classList.remove('hidden');
  };

  const open = () => {
    renderSounds();
    showBrowse();
    overlay.classList.remove('hidden');
  };
  const close = () => {
    trimmer?.stopPreview();
    overlay.classList.add('hidden');
  };

  openBtn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.classList.contains('hidden')) close();
  });

  // O botão "Parar" só aparece enquanto houver som(s) tocando; ao clicar, para
  // todos de uma vez (o servidor propaga o stop ao canal de voz).
  stopBtn.classList.add('hidden');
  voiceClient.onSoundboardChange = (count) => stopBtn.classList.toggle('hidden', count === 0);
  stopBtn.addEventListener('click', () => request('soundboard:stop').catch(() => {}));

  addToggle.addEventListener('click', showAdd);
  cancelBtn.addEventListener('click', () => {
    resetForm();
    showBrowse();
  });

  audioInput.addEventListener('change', () => handleAudioFile(audioInput.files?.[0]));

  // Arrastar e soltar um áudio em qualquer lugar do modal aberto.
  const card = overlay.querySelector('.modal-card');
  let dragDepth = 0;
  overlay.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    card.classList.add('drop-active');
  });
  overlay.addEventListener('dragover', (e) => e.preventDefault());
  overlay.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) card.classList.remove('drop-active');
  });
  overlay.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    card.classList.remove('drop-active');
    const file = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith('audio/'));
    if (file) handleAudioFile(file);
    else hint.textContent = 'Solte um arquivo de áudio.';
  });

  // Processa um áudio escolhido (input ou drag&drop): prepara nome, decodifica
  // e monta o trimmer. Reutilizado pelos dois caminhos.
  async function handleAudioFile(file) {
    if (!file) return;
    if (!file.type.startsWith('audio/')) {
      hint.textContent = 'Isso não parece um arquivo de áudio.';
      return;
    }
    audioFile = file;
    showAdd();
    // Por padrão, o nome do som é o nome do arquivo (sem extensão). Não
    // sobrescreve se o usuário já digitou algo.
    if (!nameInput.value.trim()) nameInput.value = baseName(file.name);
    hint.textContent = 'Processando áudio…';
    try {
      decodedBuffer = await decodeAudio(file);
      trimmer?.destroy();
      trimmerBox.classList.remove('hidden'); // visível antes de medir a largura do canvas
      trimmer = createTrimmer({ canvas, audioBuffer: decodedBuffer, onChange: updateRangeLabel });
      updateRangeLabel(trimmer.getRange());
      hint.textContent = '';
    } catch {
      // Formato que o navegador não decodifica: sobe o arquivo inteiro, sem corte.
      decodedBuffer = null;
      trimmer = null;
      trimmerBox.classList.add('hidden');
      hint.textContent = 'Não consegui abrir esse áudio para cortar; ele será enviado inteiro.';
    }
  }

  previewBtn.addEventListener('click', () => trimmer?.previewSelection());

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) {
      hint.textContent = 'Dê um nome ao som.';
      return;
    }
    if (!audioFile) {
      hint.textContent = 'Escolha um arquivo de áudio.';
      return;
    }

    submitBtn.disabled = true;
    hint.textContent = 'Enviando…';
    try {
      let blob = audioFile;
      let filename = audioFile.name || 'sound';

      // Recorta só se houve seleção diferente do áudio inteiro.
      if (decodedBuffer && trimmer) {
        const { start, end } = trimmer.getRange();
        if (start > 0.01 || end < decodedBuffer.duration - 0.01) {
          blob = trimToWavBlob(decodedBuffer, start, end);
          filename = `${name.replace(/\s+/g, '_')}.wav`;
        }
      }

      const uploaded = await uploadAudioFile(blob, filename);
      await request('soundboard:add', {
        name,
        url: uploaded.url,
        mime: uploaded.mime,
        size: uploaded.size,
      });

      resetForm();
      showBrowse();
    } catch (err) {
      hint.textContent = err.message;
    } finally {
      submitBtn.disabled = false;
    }
  });

  function updateRangeLabel({ start, end }) {
    rangeLabel.textContent = `${fmt(start)} – ${fmt(end)}  (trecho: ${fmt(end - start)})`;
  }

  function resetForm() {
    trimmer?.destroy();
    trimmer = null;
    decodedBuffer = null;
    audioFile = null;
    closeAudioContext();
    form.reset();
    trimmerBox.classList.add('hidden');
    rangeLabel.textContent = '';
    hint.textContent = '';
  }
}

/** Renderiza a grade de sons. Assina o estado (chamado no subscribe do main). */
export function renderSounds() {
  const grid = document.getElementById('soundboard-grid');
  if (!grid) return;
  const { sounds, me } = getState();
  clear(grid);

  if (!sounds.length) {
    grid.append(
      el('div', { class: 'soundboard-empty' }, 'Nenhum som ainda. Clique em "Adicionar som" ou arraste um áudio para cá.')
    );
    return;
  }

  for (const s of sounds) {
    const canDelete = me && (me.isAdmin || s.uploaderId === me.id);
    grid.append(
      el('div', { class: 'sound-tile' }, [
        el(
          'button',
          {
            class: 'sound-play',
            title: s.uploaderName ? `${s.name} — por ${s.uploaderName}` : s.name,
            onClick: () => request('soundboard:play', { id: s.id }).catch((err) => alert(err.message)),
          },
          [el('span', { class: 'sound-name' }, s.name)]
        ),
        canDelete
          ? el(
              'button',
              {
                class: 'icon-btn danger sound-del',
                title: 'Apagar',
                onClick: () => {
                  if (confirm(`Apagar "${s.name}"?`)) {
                    request('soundboard:delete', { id: s.id }).catch((err) => alert(err.message));
                  }
                },
              },
              icon('trash')
            )
          : null,
      ])
    );
  }
}

function baseName(filename) {
  return String(filename || 'som')
    .replace(/\.[^./\\]+$/, '')
    .slice(0, 48);
}

function fmt(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const d = Math.floor((sec * 10) % 10);
  return `${m}:${String(s).padStart(2, '0')}.${d}`;
}

async function uploadAudioFile(blobOrFile, filename) {
  const body = new FormData();
  body.append('file', blobOrFile, filename);
  const res = await fetch('/api/upload/audio', { method: 'POST', body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'Falha no upload do áudio.');
  return json;
}
