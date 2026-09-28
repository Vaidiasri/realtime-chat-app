import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { UserSummary } from '@chat/shared';
import { logout } from '../api';
import {
  connectSocket,
  messageAction,
  sendMessage,
  type ActionResult,
  type AppSocket,
  type MessageAction,
  type SendResult,
} from '../socket';
import type { MessageSendPayload } from '@chat/shared';
import {
  bumpUnread,
  dropConversation,
  putConversation,
  putGroup,
  putMessage,
  putPresence,
  putReceipt,
  syncAll,
} from './cache';
import { ChatPane } from './ChatPane';
import { GroupPanel } from './GroupPanel';
import { Sidebar } from './Sidebar';

const TYPING_TTL_MS = 6_000;

/** Who is typing where: conversation id, then user id, then when it expires. */
type Typing = Readonly<Record<string, Readonly<Record<string, number>>>>;

// A new map with one typer set until `until`, or removed when `until` is null.
const setTyper = (all: Typing, conversationId: string, userId: string, until: number | null) => {
  const rest = Object.fromEntries(
    Object.entries(all[conversationId] ?? {}).filter(([id]) => id !== userId),
  );
  return { ...all, [conversationId]: until === null ? rest : { ...rest, [userId]: until } };
};

export function ChatApp({ me, onSignedOut }: { me: UserSummary; onSignedOut: () => void }) {
  const qc = useQueryClient();
  // connecting: before the first connect. reconnecting: dropped, or back but still syncing.
  const [link, setLink] = useState<'connecting' | 'live' | 'reconnecting'>('connecting');
  const [openId, setOpenId] = useState<string | null>(null);
  const [info, setInfo] = useState(false);
  const [notice, setNotice] = useState('');
  // The socket handlers are bound once; they read the open pane through this ref.
  const openRef = useRef(openId);
  useEffect(() => {
    openRef.current = openId;
  }, [openId]);
  const socketRef = useRef<{ socket: AppSocket; stop: () => void }>(undefined);

  // The highest id already marked per conversation and kind: only a higher one is sent.
  // Not volatile: a mark sent while offline is buffered and goes out on reconnect.
  const marked = useRef(new Map<string, bigint>());
  const mark = useCallback(
    (conversationId: string, messageId: string, kind: 'delivered' | 'read') => {
      const id = BigInt(messageId);
      const key = `${conversationId}:${kind}`;
      if ((marked.current.get(key) ?? 0n) >= id) return;
      marked.current.set(key, id);
      socketRef.current?.socket.emit('receipt:mark', { conversationId, messageId, kind });
    },
    [],
  );
  const [typing, setTyping] = useState<Typing>({});
  const anyTyping = Object.values(typing).some((c) => Object.keys(c).length > 0);

  // Drop typers whose last start is older than the TTL. Runs only while someone is typing.
  useEffect(() => {
    if (!anyTyping) return;
    const t = setInterval(() => {
      const now = Date.now();
      setTyping((all) =>
        Object.fromEntries(
          Object.entries(all).map(([id, c]) => [
            id,
            Object.fromEntries(Object.entries(c).filter(([, until]) => until > now)),
          ]),
        ),
      );
    }, 1_000);
    return () => clearInterval(t);
  }, [anyTyping]);

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
    socket.on('message:new', (m) => {
      putMessage(qc, m);
      setTyping((all) => setTyper(all, m.conversationId, m.senderId, null));
      if (m.senderId === me.id) return;
      // An open, visible chat marks it read itself (ChatPane). Anything else is only delivered.
      if (openRef.current === m.conversationId && document.visibilityState === 'visible') return;
      mark(m.conversationId, m.id, 'delivered');
      bumpUnread(qc, m.conversationId);
    });
    socket.on('message:updated', (m) => putMessage(qc, m));
    socket.on('receipt:update', (r) => putReceipt(qc, r, me.id));
    socket.on('presence:update', (p) => putPresence(qc, p));
    // The sender's other tabs get their own typing too; never show yourself.
    socket.on('typing:update', (t) => {
      if (t.userId === me.id) return;
      setTyping((all) =>
        setTyper(all, t.conversationId, t.userId, t.typing ? Date.now() + TYPING_TTL_MS : null),
      );
    });
    socket.on('conversation:new', (c) => putConversation(qc, c));
    socket.on('group:updated', (g) => putGroup(qc, g, me.id));
    socket.on('group:removed', (r) => {
      dropConversation(qc, r.conversationId);
      if (openRef.current !== r.conversationId) return;
      setOpenId(null);
      setInfo(false);
      setNotice(
        r.reason === 'deleted'
          ? `${r.name} was deleted.`
          : r.reason === 'left'
            ? `You left ${r.name}.`
            : `You were removed from ${r.name}.`,
      );
    });
    socketRef.current = conn;
    return conn.stop;
  }, [qc, onSignedOut, me.id, mark]);

  const openConversation = (id: string | null) => {
    setOpenId(id);
    setInfo(false);
    setNotice('');
  };

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

  const act = (a: MessageAction): Promise<ActionResult> =>
    socketRef.current
      ? messageAction(socketRef.current.socket, a)
      : Promise.resolve({ ok: false, error: 'timeout' });

  // Volatile: a typing event is worthless later, so it is dropped while offline, not queued.
  const signalTyping = useCallback((conversationId: string, on: boolean) => {
    socketRef.current?.socket.volatile.emit(on ? 'typing:start' : 'typing:stop', {
      conversationId,
    });
  }, []);

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
        {notice && (
          <p className="flex items-center justify-center gap-3 bg-slate-200 px-4 py-1 text-sm font-medium">
            {notice}
            <button type="button" onClick={() => setNotice('')} className="underline">
              Dismiss
            </button>
          </p>
        )}
      </div>
      <div className="flex min-h-0 flex-1">
        <aside
          className={`${open ? 'hidden md:flex' : 'flex'} w-full flex-col border-r border-slate-200 bg-white md:w-80`}
        >
          <Sidebar openId={openId} onOpen={openConversation} />
        </aside>
        <section className={`${open ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col`}>
          {openId ? (
            <ChatPane
              key={openId}
              conversationId={openId}
              me={me}
              send={send}
              act={act}
              typers={Object.keys(typing[openId] ?? {})}
              onTyping={signalTyping}
              onRead={mark}
              onBack={() => openConversation(null)}
              onInfo={() => setInfo(true)}
            />
          ) : (
            <p className="m-auto px-4 text-center text-slate-500">
              Pick a conversation, or search for someone to start one.
            </p>
          )}
        </section>
        {openId && info && (
          <GroupPanel key={openId} groupId={openId} me={me} onClose={() => setInfo(false)} />
        )}
      </div>
    </div>
  );
}
