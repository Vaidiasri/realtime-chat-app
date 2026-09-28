import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { UserSummary } from '@chat/shared';
import { logout } from '../api';
import { ChatIcon, Logo } from '../icons';

const toggleTheme = () => {
  const dark = document.documentElement.classList.toggle('dark');
  try {
    localStorage.setItem('theme', dark ? 'dark' : 'light');
  } catch {
    // Storage blocked: the toggle still works for this page.
  }
};
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
    <div className="flex h-dvh flex-col text-slate-900 md:gap-3 md:p-3">
      <header className="glass flex items-center justify-between gap-3 border-b border-slate-200/70 px-4 py-2 md:panel md:rounded-2xl">
        <span className="flex min-w-0 items-center gap-3">
          <Logo />
          <span className="hidden font-semibold tracking-tight sm:inline">Chat</span>
          <span aria-hidden="true" className="hidden h-4 w-px bg-slate-200 sm:inline" />
          <span className="truncate text-sm font-medium text-slate-700">{me.displayName}</span>
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 px-2 text-xs font-medium ${link === 'live' ? 'text-green-700' : 'text-amber-700'}`}
          >
            <span
              aria-hidden="true"
              className={`size-1.5 rounded-full ${link === 'live' ? 'bg-green-500' : 'animate-pulse bg-amber-500'}`}
            />
            {link === 'live' ? 'Connected' : link === 'connecting' ? 'Connecting...' : 'Offline'}
          </span>
          <button type="button" onClick={toggleTheme} className="btn">
            Theme
          </button>
          <button type="button" onClick={() => void signOut()} className="btn">
            Log out
          </button>
        </div>
      </header>
      <div role="status" className="flex flex-col gap-2 empty:hidden max-md:py-2">
        {link === 'reconnecting' && (
          <p className="mx-auto w-fit rounded-full bg-amber-100 px-4 py-1 text-center text-sm font-medium text-amber-900 shadow-sm">
            Reconnecting...
          </p>
        )}
        {notice && (
          <p className="glass panel mx-auto flex w-fit items-center justify-center gap-3 rounded-full px-4 py-1 text-sm font-medium">
            {notice}
            <button
              type="button"
              onClick={() => setNotice('')}
              className="text-accent hover:underline"
            >
              Dismiss
            </button>
          </p>
        )}
      </div>
      <div className="flex min-h-0 flex-1 md:gap-3">
        <aside
          className={`${open ? 'hidden md:flex' : 'flex'} glass w-full flex-col md:panel md:w-80 md:rounded-2xl`}
        >
          <Sidebar openId={openId} onOpen={openConversation} />
        </aside>
        <section
          className={`${open ? 'flex' : 'hidden md:flex'} glass min-w-0 flex-1 flex-col md:panel md:overflow-hidden md:rounded-2xl`}
        >
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
            <div className="m-auto flex flex-col items-center gap-3 px-4 text-center">
              <span className="flex size-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
                <ChatIcon />
              </span>
              <p className="max-w-xs text-sm text-slate-500">
                Pick a conversation, or search for someone to start one.
              </p>
            </div>
          )}
        </section>
        {openId && info && (
          <GroupPanel key={openId} groupId={openId} me={me} onClose={() => setInfo(false)} />
        )}
      </div>
    </div>
  );
}
