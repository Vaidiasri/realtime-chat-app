import http from 'node:http';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@chat/shared';
import { config } from './config.js';
import { migrateToLatest } from './db/index.js';
import { createApp } from './app.js';
import { logger } from './logger.js';

try {
  await migrateToLatest();
} catch (err) {
  logger.fatal({ err }, 'migration failed');
  process.exit(1);
}

const server = http.createServer(createApp());
const io = new Server<ClientToServerEvents, ServerToClientEvents>(server);

// ponytail: rejects every socket until the auth feature (5) adds handshake verification.
io.use((_socket, next) => next(new Error('unauthorized')));

server.listen(config.PORT, () => {
  logger.info(`listening on :${config.PORT}`);
});
