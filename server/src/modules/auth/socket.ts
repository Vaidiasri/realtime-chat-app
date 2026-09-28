import { authRefreshPayload, type AuthRefreshAck } from '@chat/shared';
import type { AppServer } from '../../io.js';
import * as auth from './service.js';

const unauthorized: AuthRefreshAck = { ok: false, error: 'unauthorized' };

// Handshake auth plus a per socket deadline: no socket stays trusted past its token's exp.
export function registerAuthSocket(io: AppServer): void {
  io.use(async (socket, next) => {
    try {
      const token = (socket.handshake.auth as { token?: unknown }).token;
      socket.data = await auth.verifySocketToken(token);
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const { userId, sid } = socket.data;
    void socket.join([`user:${userId}`, `session:${sid}`]);

    let deadline: NodeJS.Timeout | undefined;
    const arm = (exp: number) => {
      clearTimeout(deadline);
      deadline = setTimeout(() => socket.disconnect(true), exp * 1000 - Date.now());
    };
    arm(socket.data.exp);
    socket.on('disconnect', () => clearTimeout(deadline));

    socket.on('auth:refresh', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => undefined;
      const parsed = authRefreshPayload.safeParse(payload);
      try {
        if (!parsed.success) throw new Error('bad payload');
        const claims = await auth.verifySocketRefresh(socket.data, parsed.data.token);
        socket.data.exp = claims.exp;
        arm(claims.exp);
        reply({ ok: true });
      } catch {
        reply(unauthorized);
        socket.disconnect(true);
      }
    });
  });
}
