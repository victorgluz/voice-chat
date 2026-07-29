import { request } from '../socket.js';

const TOKEN_KEY = 'voicechat_token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

/**
 * Tela de autenticação com duas abas: Entrar (e-mail + senha) e Criar conta
 * (nome + e-mail + senha + avatar opcional). O cadastro/login é feito por HTTP
 * e devolve um token, guardado no localStorage; a presença em tempo real é
 * estabelecida via socket ('auth:session'). Ao carregar a página, se houver
 * token salvo tentamos retomar a sessão automaticamente (sem relogar no F5).
 */
export function initLogin(onLoggedIn) {
  const overlay = document.getElementById('login-overlay');
  const form = document.getElementById('login-form');
  const tabs = document.getElementById('auth-tabs');
  const tabLogin = document.getElementById('tab-login');
  const tabRegister = document.getElementById('tab-register');
  const registerOnly = document.getElementById('register-only');
  const loading = document.getElementById('login-loading');
  const nameInput = document.getElementById('field-name');
  const emailInput = document.getElementById('field-email');
  const passwordInput = document.getElementById('field-password');
  const avatarInput = document.getElementById('login-avatar');
  const preview = document.getElementById('login-avatar-preview');
  const error = document.getElementById('login-error');
  const submit = document.getElementById('login-submit');

  let mode = 'login'; // 'login' | 'register'
  let avatarUrl = null;

  function setMode(next) {
    mode = next;
    error.textContent = '';
    tabLogin.classList.toggle('active', mode === 'login');
    tabRegister.classList.toggle('active', mode === 'register');
    registerOnly.classList.toggle('hidden', mode !== 'register');
    nameInput.required = mode === 'register';
    submit.textContent = mode === 'register' ? 'Criar conta' : 'Entrar';
    passwordInput.setAttribute('autocomplete', mode === 'register' ? 'new-password' : 'current-password');
  }

  tabLogin.addEventListener('click', () => setMode('login'));
  tabRegister.addEventListener('click', () => setMode('register'));

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
      const endpoint = mode === 'register' ? '/api/auth/register' : '/api/auth/login';
      const body =
        mode === 'register'
          ? {
              name: nameInput.value,
              email: emailInput.value,
              password: passwordInput.value,
              avatar: avatarUrl,
            }
          : { email: emailInput.value, password: passwordInput.value };

      const { token } = await postJson(endpoint, body);
      setToken(token);
      await startSession(token);
    } catch (err) {
      error.textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  });

  // Estabelece a sessão em tempo real com o token e entra no app.
  async function startSession(token) {
    const data = await request('auth:session', { token });
    overlay.classList.add('hidden');
    onLoggedIn(data);
  }

  // Retomada automática: se há token salvo, tenta reconectar sem mostrar o form.
  const saved = getToken();
  if (saved) {
    form.classList.add('hidden');
    loading.classList.remove('hidden');
    startSession(saved).catch(() => {
      clearToken();
      loading.classList.add('hidden');
      form.classList.remove('hidden');
    });
  }
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'Falha na autenticação.');
  return json;
}

export async function uploadAvatar(file) {
  const body = new FormData();
  body.append('file', file);
  const res = await fetch('/api/upload', { method: 'POST', body });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Falha no upload do avatar.');
  return json.url;
}
