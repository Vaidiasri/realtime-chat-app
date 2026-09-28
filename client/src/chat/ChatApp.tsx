import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { UserSummary } from '@chat/shared';
import { logout } from '../api';
import { connectSocket, sendMessage, type AppSocket, type SendResult } from '../socket';
import type { MessageSendPayload } from '@chat/shared';
import { keys, putConversation, putMessage } from './cache';
import { ChatPane } from './ChatPane';
import { Sidebar } from './Sidebar';

export function ChatApp({ me, onSignedOut }: { me: UserSummary; onSignedOut: () => void }) {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const socketRef = useRef<{ socket: AppSocket; stop: () => void }>(undefined);

  useEffect(() => {
    const conn = connectSocket({ status: setConnected, signedOut: onSignedOut });
    // ponytail: refetch on every (re)connect as a cheap self heal; feature 7 adds gap free sync.
    const { socket } = conn;
    socket.on('connect', () => {
      void qc.invalidateQueries({ queryKey: keys.conversations });
      void qc.invalidateQueries({ queryKey: ['messages'] });
    });
    socket.on('message:new', (m) => putMessage(qc, m));
    socket.on('conversation:new', (c) => putConversation(qc, c));
    socketRef.current = conn;
    return conn.stop;
  }, [qc, onSignedOut]);

  const signOut = async () => {
    socketRef.current?.stop();
    await logout();
    onSignedOut();
  };

  // Read at send time, so the pane never holds a socket from a torn down effect.
  const send = (payload: MessageSendPayload): Promise<SendResult> =>
    socketRef.current
      ? sendMessage(socketRef.current.socket, payload)
      : Promise.resolve({ ok: false, error: 'timeout' });

  const open = openId !== null;
  return (
    <div className="flex h-dvh flex-col bg-slate-50 text-slate-900">
      <header className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-2">
        <span className="truncate font-medium">{me.displayName}</span>
        <div className="flex shrink-0 items-center gap-3">
          <span
            role="status"
            className={`text-sm ${connected ? 'text-green-700' : 'text-amber-700'}`}
          >
            {connected ? 'Connected' : 'Connecting...'}
          </span>
          <button
            type="button"
            onClick={() => void signOut()}
            className="rounded-md border border-slate-300 px-3 py-1 text-sm font-medium"
          >
            Log out
          </button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside
          className={`${open ? 'hidden md:flex' : 'flex'} w-full flex-col border-r border-slate-200 bg-white md:w-80`}
        >
          <Sidebar openId={openId} onOpen={setOpenId} />
        </aside>
        <section className={`${open ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col`}>
          {openId ? (
            <ChatPane
              key={openId}
              conversationId={openId}
              me={me}
              send={send}
              onBack={() => setOpenId(null)}
            />
          ) : (
            <p className="m-auto px-4 text-center text-slate-500">
              Pick a conversation, or search for someone to start one.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
