import express from 'express';
import uploadRouter from './upload.js';

const router = express.Router();

router.get('/health', (_req, res) => res.json({ ok: true }));
router.use('/', uploadRouter);

export default router;
