import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { UserSummary } from '@chat/shared';
import { logout } from '../api';
import { connectSocket, sendMessage, type AppSocket, type SendResult } from '../socket';
import type { MessageSendPayload } from '@chat/shared';
import { putConversation, putMessage, syncAll } from './cache';
import { ChatPane } from './ChatPane';
import { Sidebar } from './Sidebar';

export function ChatApp({ me, onSignedOut }: { me: UserSummary; onSignedOut: () => void }) {
  const qc = useQueryClient();
  // connecting: before the first connect. reconnecting: dropped, or back but still syncing.
  const [link, setLink] = useState<'connecting' | 'live' | 'reconnecting'>('connecting');
  const [openId, setOpenId] = useState<string | null>(null);
  const socketRef = useRef<{ socket: AppSocket; stop: () => void }>(undefined);

  useEffect(() => {
    const conn = connectSocket({
      status: (up) => {
        if (!up) setLink((l) => (l === 'connecting' ? l : 'reconnecting'));
      },
      signedOut: onSignedOut,
    });
    const { socket } = conn;
    // Every connect fills the gap since the last one; the banner stays up until that is done.
    socket.on('connect', () => {
      void syncAll(qc).finally(() => {
        if (socket.connected) setLink('live');
      });
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
          <span className={`text-sm ${link === 'live' ? 'text-green-700' : 'text-amber-700'}`}>
            {link === 'live' ? 'Connected' : link === 'connecting' ? 'Connecting...' : 'Offline'}
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
      <div role="status" className="empty:hidden">
        {link === 'reconnecting' && (
          <p className="bg-amber-100 px-4 py-1 text-center text-sm font-medium text-amber-900">
            Reconnecting...
          </p>
        )}
      </div>
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
