import express from 'express';
import * as users from '../database/repositories/users.js';
import { hashPassword, verifyPassword, signToken } from '../util/auth.js';
import { cleanName, cleanEmail, cleanAvatar } from '../util/sanitize.js';

const router = express.Router();

const MIN_PASSWORD = 6;

/** Forma pública do usuário (o que o cliente pode ver de si mesmo). */
function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, avatar: u.avatar, isAdmin: u.isAdmin };
}

// Cadastro: nome + e-mail + senha (avatar opcional). O primeiro cadastro vira admin.
router.post('/register', (req, res) => {
  try {
    const name = cleanName(req.body?.name);
    const email = cleanEmail(req.body?.email);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!name) return res.status(400).json({ error: 'Nome inválido.' });
    if (!email) return res.status(400).json({ error: 'E-mail inválido.' });
    if (password.length < MIN_PASSWORD) {
      return res.status(400).json({ error: `A senha precisa ter ao menos ${MIN_PASSWORD} caracteres.` });
    }
    if (users.getUserByEmail(email)) {
      return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });
    }

    const user = users.createUser({
      name,
      email,
      passwordHash: hashPassword(password),
      avatar: cleanAvatar(req.body?.avatar),
      isAdmin: users.countRegisteredUsers() === 0,
    });

    res.json({ token: signToken(user.id), user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login: e-mail + senha.
router.post('/login', (req, res) => {
  try {
    const email = cleanEmail(req.body?.email);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    const user = email && users.getUserByEmail(email);
    // Mensagem genérica para não revelar se o e-mail existe.
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
    }

    res.json({ token: signToken(user.id), user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
