import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { config } from '../../config/index.js';

const router = express.Router();

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

export default router;
