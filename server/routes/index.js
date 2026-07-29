import express from 'express';
import uploadRouter from './upload.js';
import authRouter from './auth.js';

const router = express.Router();

router.get('/health', (_req, res) => res.json({ ok: true }));
router.use('/auth', authRouter);
router.use('/', uploadRouter);

export default router;
