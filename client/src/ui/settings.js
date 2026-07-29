import { voiceClient } from '../voice/voice-client.js';
import { MicTest } from '../voice/mic-test.js';
import { getState, setState } from '../state.js';
import { request } from '../socket.js';
import { clearToken, uploadAvatar } from './login.js';
import { initials } from '../util/dom.js';

/**
 * Modal de configurações de voz: escolha do microfone (entrada) e da saída
 * de áudio (fone/alto-falante). As escolhas são aplicadas ao vivo e
 * persistidas pelo VoiceClient (localStorage).
 *
 * Detalhes de navegador:
 *  - Os rótulos (labels) dos dispositivos só aparecem depois que a permissão
 *    de microfone é concedida. Por isso pedimos acesso uma vez ao abrir.
 *  - setSinkId (escolher saída) não existe no Firefox/Safari; nesse caso a
 *    linha de saída é escondida.
 */
export function initSettings() {
  const btn = document.getElementById('btn-settings');
  const overlay = document.getElementById('settings-overlay');
  const closeBtn = document.getElementById('settings-close');
  const micSel = document.getElementById('sel-mic');
  const outSel = document.getElementById('sel-out');
  const outRow = document.getElementById('settings-out-row');
  const hint = document.getElementById('settings-hint');

  const testBtn = document.getElementById('mic-test-btn');
  const meterFill = document.getElementById('mic-meter-fill');
  const monitorChk = document.getElementById('mic-monitor');

  const profileName = document.getElementById('profile-name');
  const profileSave = document.getElementById('profile-save');
  const profileHint = document.getElementById('profile-hint');
  const avatarInput = document.getElementById('profile-avatar-input');
  const avatarPreview = document.getElementById('profile-avatar-preview');
  const logoutBtn = document.getElementById('btn-logout');

  initProfile();

  const canPickOutput =
    typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
  if (!canPickOutput) outRow.classList.add('hidden');

  const micTest = new MicTest();
  micTest.onLevel = (level) => {
    meterFill.style.width = Math.round(level * 100) + '%';
  };

  function stopTest() {
    micTest.stop();
    testBtn.classList.remove('active');
    testBtn.textContent = 'Testar';
    meterFill.style.width = '0%';
  }

  const close = () => {
    stopTest();
    overlay.classList.add('hidden');
  };

  btn.addEventListener('click', () => open());
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.classList.contains('hidden')) close();
  });

  testBtn.addEventListener('click', async () => {
    if (micTest.active) {
      stopTest();
      return;
    }
    try {
      await micTest.start({
        inputDeviceId: voiceClient.inputDeviceId,
        outputDeviceId: voiceClient.outputDeviceId,
        monitor: monitorChk.checked,
      });
      testBtn.classList.add('active');
      testBtn.textContent = 'Parar teste';
      hint.textContent = '';
    } catch (err) {
      hint.textContent = 'Não foi possível acessar o microfone: ' + err.message;
    }
  });

  monitorChk.addEventListener('change', () => micTest.setMonitor(monitorChk.checked));

  micSel.addEventListener('change', async () => {
    try {
      await voiceClient.setInputDevice(micSel.value || null);
      await micTest.setInput(micSel.value || null, voiceClient.outputDeviceId);
    } catch (err) {
      hint.textContent = 'Falha ao trocar o microfone: ' + err.message;
    }
  });

  outSel.addEventListener('change', async () => {
    try {
      await voiceClient.setOutputDevice(outSel.value || null);
      await micTest.setOutput(outSel.value || null);
    } catch (err) {
      hint.textContent = 'Falha ao trocar a saída: ' + err.message;
    }
  });

  // Re-popula a lista quando dispositivos são conectados/removidos.
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    if (!overlay.classList.contains('hidden')) refresh();
  });

  // Reflete o avatar atual no preview das configurações e no painel próprio
  // (canto inferior esquerdo). A lista de membros à direita é atualizada pelo
  // presence:update que o servidor propaga a todos.
  function paintAvatar() {
    const me = getState().me;
    const selfAvatar = document.getElementById('self-avatar');
    for (const node of [avatarPreview, selfAvatar]) {
      if (!node) continue;
      if (me.avatar?.startsWith('/uploads/')) {
        node.style.backgroundImage = `url(${me.avatar})`;
        node.textContent = '';
      } else {
        node.style.backgroundImage = '';
        node.textContent = me.avatar || initials(me.name);
      }
    }
  }

  // Perfil: editar o próprio nome, a foto e sair da conta.
  function initProfile() {
    paintAvatar();

    // Trocar a foto: envia por HTTP, persiste a URL via socket e propaga a
    // todos (presence:update), para que o novo avatar apareça no painel de
    // todos os usuários conectados em tempo real.
    avatarInput.addEventListener('change', async () => {
      const file = avatarInput.files?.[0];
      if (!file) return;
      profileHint.textContent = 'Enviando foto…';
      try {
        const url = await uploadAvatar(file);
        const { avatar } = await request('user:updateAvatar', { avatar: url });
        setState({ me: { ...getState().me, avatar } });
        paintAvatar();
        profileHint.textContent = 'Foto atualizada ✓';
      } catch (err) {
        profileHint.textContent = err.message;
      } finally {
        avatarInput.value = '';
      }
    });

    async function save() {
      const name = profileName.value.trim();
      profileHint.textContent = '';
      if (!name) {
        profileHint.textContent = 'Digite um nome.';
        return;
      }
      profileSave.disabled = true;
      try {
        const { name: saved } = await request('user:updateName', { name });
        setState({ me: { ...getState().me, name: saved } });
        document.getElementById('self-name').textContent = saved;
        profileName.value = saved;
        profileHint.textContent = 'Nome atualizado ✓';
      } catch (err) {
        profileHint.textContent = err.message;
      } finally {
        profileSave.disabled = false;
      }
    }

    profileSave.addEventListener('click', save);
    profileName.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        save();
      }
    });

    logoutBtn.addEventListener('click', () => {
      clearToken();
      location.reload();
    });
  }

  async function open() {
    hint.textContent = '';
    profileHint.textContent = '';
    profileName.value = getState().me?.name || '';
    paintAvatar();
    await ensureLabels(hint);
    await refresh();
    overlay.classList.remove('hidden');
  }

  async function refresh() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    fill(
      micSel,
      devices.filter((d) => d.kind === 'audioinput'),
      voiceClient.inputDeviceId,
      'Microfone padrão'
    );
    if (canPickOutput) {
      fill(
        outSel,
        devices.filter((d) => d.kind === 'audiooutput'),
        voiceClient.outputDeviceId,
        'Saída padrão'
      );
    }
  }
}

function fill(select, devices, current, defaultLabel) {
  select.innerHTML = '';
  const def = document.createElement('option');
  def.value = '';
  def.textContent = defaultLabel;
  select.append(def);

  devices.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Dispositivo ${i + 1}`;
    select.append(opt);
  });

  // Se o dispositivo salvo não existir mais, cai no padrão.
  select.value = devices.some((d) => d.deviceId === current) ? current : '';
}

/** Rótulos só aparecem após permissão de microfone. Pede uma vez, se preciso. */
async function ensureLabels(hint) {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const hasLabels = devices.some((d) => d.kind === 'audioinput' && d.label);
  if (hasLabels) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch {
    hint.textContent = 'Permita o microfone para ver os nomes dos dispositivos.';
  }
}
