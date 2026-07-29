import express from 'express';
import { config } from '../config/index.js';
import apiRouter from './routes/index.js';

export function createApp() {
  const app = express();

  app.use(express.json({ limit: '256kb' }));

  // Arquivos enviados. nosniff evita que o browser interprete um upload
  // como HTML/JS executável.
  app.use(
    '/uploads',
    express.static(config.paths.uploads, {
      setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
      index: false,
    })
  );

  app.use('/api', apiRouter);

  // Frontend estático.
  app.use(express.static(config.paths.public));

  return app;
}
