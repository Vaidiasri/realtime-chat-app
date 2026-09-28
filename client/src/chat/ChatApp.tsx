import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { UserSummary } from '@chat/shared';
import { logout } from '../api';
import { LogOut, MessageCircle, PanelLeftClose, PanelLeftOpen, SunMoon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Logo } from '../icons';

const readCollapsed = () => {
  try {
    return localStorage.getItem('sidebar') === 'collapsed';
  } catch {
    return false;
  }
};

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
import { Avatar, Sidebar } from './Sidebar';

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
  // Only md and up: below that the list and the chat already swap places.
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const collapse = (next: boolean) => {
    setCollapsed(next);
    try {
      localStorage.setItem('sidebar', next ? 'collapsed' : 'open');
    } catch {
      // Storage blocked: the choice lasts for this page.
    }
  };
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

  const account = (compact: boolean) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className={compact ? 'size-10 rounded-full p-0' : 'h-9 gap-2 rounded-full pr-1 pl-3'}
          aria-label={`Account, ${link === 'live' ? 'connected' : link === 'connecting' ? 'connecting' : 'offline'}`}
        >
          {!compact && (
            <span className="max-w-28 truncate text-sm font-medium">{me.displayName}</span>
          )}
          <span className="relative">
            <Avatar name={me.displayName} url={null} size="default" />
            <span
              aria-hidden="true"
              className={`absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-background ${link === 'live' ? 'bg-success' : 'animate-pulse bg-warning'}`}
            />
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={compact ? 'start' : 'end'}
        side={compact ? 'right' : 'bottom'}
        className="w-56"
      >
        <DropdownMenuLabel className="flex flex-col gap-0.5 px-2 py-1.5">
          <span className="truncate text-sm font-medium text-foreground">{me.displayName}</span>
          <span className="text-xs font-normal text-muted-foreground">
            {link === 'live' ? 'Connected' : link === 'connecting' ? 'Connecting...' : 'Offline'}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={toggleTheme}>
          <SunMoon />
          Toggle theme
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={() => void signOut()}>
          <LogOut />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const open = openId !== null;
  return (
    <div className="flex h-dvh bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <div
        role="status"
        className="pointer-events-none fixed inset-x-0 top-3 z-50 flex flex-col items-center gap-2 px-4 empty:hidden"
      >
        {link === 'reconnecting' && (
          <p className="pointer-events-auto flex items-center gap-2 rounded-full bg-popover px-4 py-1.5 text-sm font-medium shadow-lg ring-1 ring-foreground/10">
            <span aria-hidden="true" className="size-2 animate-pulse rounded-full bg-warning" />
            Reconnecting...
          </p>
        )}
        {notice && (
          <p className="pointer-events-auto flex max-w-full items-center gap-3 rounded-full bg-popover py-1 pr-1 pl-4 text-sm font-medium shadow-lg ring-1 ring-foreground/10">
            <span className="min-w-0 truncate">{notice}</span>
            <Button variant="ghost" size="sm" onClick={() => setNotice('')}>
              Dismiss
            </Button>
          </p>
        )}
      </div>
      <aside
        className={`${open ? 'hidden md:flex' : 'flex'} ${collapsed ? 'md:hidden' : ''} w-full flex-col border-r bg-muted/40 md:w-72 lg:w-80 dark:bg-card/40`}
      >
        <header className="flex items-center justify-between gap-2 px-4 pt-3 pb-2">
          <span className="flex items-center gap-2.5">
            <Logo />
            <span className="font-semibold tracking-tight">Chat</span>
          </span>
          <span className="flex items-center gap-1">
            {account(false)}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => collapse(true)}
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
              className="hidden text-muted-foreground md:inline-flex"
            >
              <PanelLeftClose />
            </Button>
          </span>
        </header>
        <Sidebar openId={openId} onOpen={openConversation} />
      </aside>
      {collapsed && (
        <nav
          aria-label="Collapsed sidebar"
          className="hidden w-16 shrink-0 flex-col items-center gap-2 border-r bg-muted/40 py-3 md:flex dark:bg-card/40"
        >
          <Logo />
          <Button
            variant="ghost"
            size="icon"
            onClick={() => collapse(false)}
            aria-label="Expand sidebar"
            title="Expand sidebar"
            className="mt-2 text-muted-foreground"
          >
            <PanelLeftOpen />
          </Button>
          <span className="mt-auto">{account(true)}</span>
        </nav>
      )}
      <div className="flex min-h-0 min-w-0 flex-1">
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
            <div className="m-auto flex flex-col items-center gap-4 px-6 text-center">
              <span className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <MessageCircle className="size-6" />
              </span>
              <div className="flex flex-col gap-1">
                <p className="font-medium">No conversation open</p>
                <p className="max-w-xs text-sm text-muted-foreground">
                  Pick a conversation, or search for someone to start one.
                </p>
              </div>
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
