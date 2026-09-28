import http from 'node:http';
import { Server } from 'socket.io';
import { config } from './config.js';
import { migrateToLatest } from './db/index.js';
import { createApp } from './app.js';
import { logger } from './logger.js';
import type { AppServer } from './io.js';
import { registerAuthSocket } from './modules/auth/socket.js';
import { registerConversationSocket } from './modules/conversations/socket.js';
import { registerGroupSocket } from './modules/groups/socket.js';
import { registerPresenceSocket } from './modules/presence/socket.js';

try {
  await migrateToLatest();
} catch (err) {
  logger.fatal({ err }, 'migration failed');
  process.exit(1);
}

// io first: REST handlers (logout, refresh reuse) disconnect a session's sockets.
const io: AppServer = new Server();
const server = http.createServer(createApp(io));
io.attach(server);
registerAuthSocket(io);
registerConversationSocket(io);
registerGroupSocket(io);
registerPresenceSocket(io);

server.listen(config.PORT, () => {
  logger.info(`listening on :${config.PORT}`);
});
