import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@chat/shared';
import { refreshSession, tokenTimes } from './api';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface Handlers {
  status: (connected: boolean) => void;
  signedOut: () => void;
}

/**
 * Connects with the access token and keeps it fresh: refreshes 60 s before exp (or halfway for
 * very short test TTLs) and sends `auth:refresh`. After a server side drop or an `unauthorized`
 * connect error it refreshes once and reconnects; if that fails the user is signed out.
 * Returns a stop function.
 */
export function connectSocket(initialToken: string, on: Handlers): () => void {
  let token = initialToken;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let retried = false;
  // auth as a callback: every reconnect sends the latest token.
  const socket: AppSocket = io({ auth: (cb) => cb({ token }), autoConnect: false });

  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    socket.disconnect();
  };

  const schedule = () => {
    const { iat, exp } = tokenTimes(token);
    const lead = Math.min(60, (exp - iat) / 2) * 1000;
    clearTimeout(timer);
    timer = setTimeout(() => void renew(), Math.max(0, exp * 1000 - Date.now() - lead));
  };

  const renew = async (): Promise<boolean> => {
    const next = await refreshSession();
    if (stopped) return false;
    if (!next) {
      stop();
      on.signedOut();
      return false;
    }
    token = next.accessToken;
    schedule();
    // A refusal needs no handling here: the server disconnects and recover() takes over.
    if (socket.connected) socket.emit('auth:refresh', { token }, () => undefined);
    return true;
  };

  const recover = async () => {
    if (stopped) return;
    if (retried) {
      stop();
      on.signedOut();
      return;
    }
    retried = true;
    if (await renew()) socket.connect();
  };

  socket.on('connect', () => {
    retried = false;
    on.status(true);
  });
  socket.on('disconnect', (reason) => {
    on.status(false);
    if (reason === 'io server disconnect') void recover();
  });
  socket.on('connect_error', (err) => {
    on.status(false);
    if (err.message === 'unauthorized') void recover();
  });

  schedule();
  socket.connect();
  return stop;
}
