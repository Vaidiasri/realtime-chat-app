import { io, type Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  MessageActionAck,
  MessageDeletePayload,
  MessageEditPayload,
  MessageReactPayload,
  MessageSendAck,
  MessageSendPayload,
  ServerToClientEvents,
} from '@chat/shared';
import { getAccessToken, refreshSession, tokenTimes } from './api';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface Handlers {
  status: (connected: boolean) => void;
  signedOut: () => void;
}

/**
 * Connects with the access token and keeps it fresh: refreshes 60 s before exp (or halfway for
 * very short test TTLs) and sends `auth:refresh`. After a server side drop or an `unauthorized`
 * connect error it refreshes once and reconnects; if that fails the user is signed out.
 */
export function connectSocket(on: Handlers): { socket: AppSocket; stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let retried = false;
  // auth as a callback: every reconnect sends the latest token.
  const socket: AppSocket = io({
    auth: (cb) => cb({ token: getAccessToken() }),
    autoConnect: false,
  });

  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    socket.disconnect();
  };

  const schedule = () => {
    const token = getAccessToken();
    if (!token) return;
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
    schedule();
    // A refusal needs no handling here: the server disconnects and recover() takes over.
    if (socket.connected) socket.emit('auth:refresh', { token: next.accessToken }, () => undefined);
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
  return { socket, stop };
}

export type SendResult = MessageSendAck | { ok: false; error: 'timeout' };

/**
 * Up to 3 attempts, 10 s each, all with the same clientId, so the server stores one row.
 * Retries wrap only this event: the global `retries` option would queue `auth:refresh` behind sends.
 */
export async function sendMessage(
  socket: AppSocket,
  payload: MessageSendPayload,
): Promise<SendResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return (await socket.timeout(10_000).emitWithAck('message:send', payload)) as MessageSendAck;
    } catch {
      // No ack in time; try again with the same clientId.
    }
  }
  return { ok: false, error: 'timeout' };
}

export type ActionResult = MessageActionAck | { ok: false; error: 'timeout' };
export type MessageAction =
  | { event: 'message:edit'; payload: MessageEditPayload }
  | { event: 'message:delete'; payload: MessageDeletePayload }
  | { event: 'message:react'; payload: MessageReactPayload };

/** One attempt: each action is safe to repeat, so the user can simply try again. */
export async function messageAction(socket: AppSocket, a: MessageAction): Promise<ActionResult> {
  try {
    return (await socket.timeout(10_000).emitWithAck(a.event, a.payload)) as MessageActionAck;
  } catch {
    return { ok: false, error: 'timeout' };
  }
}
