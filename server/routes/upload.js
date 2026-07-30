import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { config } from '../../config/index.js';

const router = express.Router();

// Extensão a partir do mime (para preservar GIF animado etc.).
const IMAGE_EXT = {
  'image/gif': '.gif',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
};

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.paths.uploads),
  filename: (_req, file, cb) => {
    // Nunca confiar no nome original: geramos um UUID e preservamos só a extensão.
    const ext = path.extname(file.originalname).slice(0, 10).replace(/[^.a-z0-9]/gi, '');
    cb(null, `${randomUUID()}${ext}`);
  },
});

function fileFilter(_req, file, cb) {
  const allowed = config.uploads.allowedMimePrefixes.some((p) => file.mimetype.startsWith(p));
  cb(allowed ? null : new Error('Tipo de arquivo não permitido.'), allowed);
}

function audioFilter(_req, file, cb) {
  const allowed = file.mimetype.startsWith('audio/');
  cb(allowed ? null : new Error('Apenas arquivos de áudio são permitidos.'), allowed);
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: config.uploads.maxFileSizeBytes, files: 1 },
});

// Soundboard: áudio SEM limite de tamanho (nem de duração), por pedido explícito.
// Só aceita audio/*. Multer usa diskStorage, então grava direto no disco (sem
// estourar memória); o único risco é ocupar espaço em uploads/.
const uploadAudio = multer({
  storage,
  fileFilter: audioFilter,
  limits: { files: 1 },
});

function respondWithFile(req, res, err) {
  if (err) return res.status(400).json({ error: err.message });
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });

  res.json({
    url: `/uploads/${req.file.filename}`,
    name: path.basename(req.file.originalname).slice(0, 200),
    mime: req.file.mimetype,
    size: req.file.size,
  });
}

router.post('/upload', (req, res) => {
  upload.single('file')(req, res, (err) => respondWithFile(req, res, err));
});

router.post('/upload/audio', (req, res) => {
  uploadAudio.single('file')(req, res, (err) => respondWithFile(req, res, err));
});

/**
 * Baixa uma imagem por URL e a hospeda como anexo. Usado ao colar uma imagem
 * da web: o navegador coloca no clipboard um PNG estático (perde o GIF), mas
 * também a URL de origem — aqui baixamos o arquivo ORIGINAL (ex.: GIF animado).
 * O download é feito no servidor (sem restrição de CORS).
 */
router.post('/upload/url', async (req, res) => {
  const src = String(req.body?.url || '').trim();
  if (!/^https?:\/\//i.test(src)) {
    return res.status(400).json({ error: 'URL inválida.' });
  }

  const max = config.uploads.maxFileSizeBytes;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 15000);
  try {
    const resp = await fetch(src, { signal: ctrl.signal, redirect: 'follow' });
    if (!resp.ok || !resp.body) {
      return res.status(400).json({ error: 'Não foi possível baixar a imagem.' });
    }

    const mime = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!mime.startsWith('image/')) {
      return res.status(400).json({ error: 'A URL não aponta para uma imagem.' });
    }

    const declared = Number(resp.headers.get('content-length'));
    if (declared && declared > max) {
      return res.status(400).json({ error: 'Imagem muito grande.' });
    }

    // Lê com teto de bytes (aborta se passar do limite).
    const chunks = [];
    let total = 0;
    for await (const chunk of resp.body) {
      total += chunk.length;
      if (total > max) {
        ctrl.abort();
        return res.status(400).json({ error: 'Imagem muito grande.' });
      }
      chunks.push(chunk);
    }
    const buf = Buffer.concat(chunks);

    const ext = IMAGE_EXT[mime] || extFromUrl(src) || '';
    const filename = `${randomUUID()}${ext}`;
    fs.writeFileSync(path.join(config.paths.uploads, filename), buf);

    let name = 'imagem' + ext;
    try {
      name = decodeURIComponent(path.basename(new URL(src).pathname)).slice(0, 200) || name;
    } catch {
      /* ignora */
    }

    res.json({ url: `/uploads/${filename}`, name, mime, size: buf.length });
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'Tempo esgotado ao baixar a imagem.' : err.message;
    res.status(400).json({ error: 'Falha ao baixar a imagem: ' + msg });
  } finally {
    clearTimeout(timeout);
  }
});

function extFromUrl(url) {
  try {
    const m = new URL(url).pathname.match(/\.[a-z0-9]{1,5}$/i);
    return m ? m[0].toLowerCase() : '';
  } catch {
    return '';
  }
}

export default router;
