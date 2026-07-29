import { request } from '../socket.js';

/** Tela de login: nome obrigatório + avatar opcional (upload). */
export function initLogin(onLoggedIn) {
  const overlay = document.getElementById('login-overlay');
  const form = document.getElementById('login-form');
  const nameInput = document.getElementById('login-name');
  const avatarInput = document.getElementById('login-avatar');
  const preview = document.getElementById('login-avatar-preview');
  const error = document.getElementById('login-error');
  const submit = document.getElementById('login-submit');

  let avatarUrl = null;

  avatarInput.addEventListener('change', async () => {
    const file = avatarInput.files?.[0];
    if (!file) return;
    try {
      avatarUrl = await uploadAvatar(file);
      preview.style.backgroundImage = `url(${avatarUrl})`;
      preview.textContent = '';
    } catch (err) {
      error.textContent = err.message;
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    submit.disabled = true;
    try {
      const data = await request('auth:login', {
        name: nameInput.value,
        avatar: avatarUrl,
      });
      overlay.classList.add('hidden');
      onLoggedIn(data);
    } catch (err) {
      error.textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  });
}

async function uploadAvatar(file) {
  const body = new FormData();
  body.append('file', file);
  const res = await fetch('/api/upload', { method: 'POST', body });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Falha no upload do avatar.');
  return json.url;
}
