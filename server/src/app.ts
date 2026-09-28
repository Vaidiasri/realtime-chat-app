import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { sql } from 'kysely';
import type { HealthResponse } from '@chat/shared';
import { db } from './db/index.js';
import { logger } from './logger.js';

const clientDist = path.resolve(import.meta.dirname, '../../client/dist');

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(pinoHttp({ logger }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  const api = express.Router();
  api.get('/health', async (_req, res) => {
    let body: HealthResponse;
    try {
      await sql`select 1`.execute(db);
      body = { ok: true, db: 'up' };
    } catch {
      body = { ok: false, db: 'down' };
    }
    res.status(body.ok ? 200 : 503).json(body);
  });
  api.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });
  app.use('/api', api);

  app.use(express.static(clientDist));
  app.get('/{*splat}', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });

  const onError: express.ErrorRequestHandler = (err, req, res, _next) => {
    req.log.error({ err }, 'unhandled error');
    res.status(500).json({ error: 'internal' });
  };
  app.use(onError);

  return app;
}
