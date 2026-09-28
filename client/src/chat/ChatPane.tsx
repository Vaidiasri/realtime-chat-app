import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DirectSummary, MessageSendPayload, UserSummary } from '@chat/shared';
import type { SendResult } from '../socket';
import {
  describeError,
  fetchMessages,
  keys,
  loadOlder,
  putMessage,
  titleOf,
  useConversations,
  useGroup,
  type ChatMessage,
} from './cache';
import { formatTime } from './Sidebar';

interface Props {
  conversationId: string;
  me: UserSummary;
  send: (payload: MessageSendPayload) => Promise<SendResult>;
  typers: string[];
  onTyping: (conversationId: string, on: boolean) => void;
  onBack: () => void;
  onInfo: () => void;
}

const TYPING_EVERY_MS = 3_000;
const TYPING_IDLE_MS = 5_000;

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export function lastSeenText(peer: DirectSummary['peer'], now: number) {
  if (peer.online) return 'Online';
  if (!peer.lastSeenAt) return 'Offline';
  const mins = Math.round((now - Date.parse(peer.lastSeenAt)) / 60_000);
  if (mins < 1) return 'Last seen just now';
  if (mins < 60) return `Last seen ${rtf.format(-mins, 'minute')}`;
  if (mins < 1440) return `Last seen ${rtf.format(-Math.round(mins / 60), 'hour')}`;
  return `Last seen ${new Date(peer.lastSeenAt).toLocaleDateString()}`;
}

export function typingText(names: readonly string[]) {
  if (names.length === 0) return '';
  if (names.length === 1) return `${names[0]} is typing...`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing...`;
  return 'Several people are typing...';
}

const failText: Record<string, string> = {
  timeout: 'Not sent: no reply from the server.',
  rate_limited: 'Not sent: you are sending too fast.',
  internal: 'Not sent: server error.',
  invalid_input: 'Not sent: the message is not valid.',
  not_found: 'Not sent: this conversation is not available.',
};
// Resending cannot fix invalid_input or not_found, so those get no Retry.
const retryable = new Set(['timeout', 'rate_limited', 'internal']);

export function ChatPane({ conversationId, me, send, typers, onTyping, onBack, onInfo }: Props) {
  const qc = useQueryClient();
  const convo = useConversations().data?.find((c) => c.id === conversationId);
  const isGroup = convo?.type === 'group';
  const group = useGroup(conversationId, isGroup);
  // Someone who left keeps their messages; their name is gone with the membership.
  const senderName = (id: string) =>
    convo?.type === 'direct'
      ? convo.peer.displayName
      : (group.data?.members.find((m) => m.userId === id)?.displayName ?? 'Former member');
  const messages = useQuery({
    queryKey: keys.messages(conversationId),
    queryFn: () => fetchMessages(qc, conversationId),
    // Never refetch on its own: that would drop loaded older pages. Sockets and syncAll keep it fresh.
    staleTime: Infinity,
  });
  const [draft, setDraft] = useState('');
  // The last seen line is relative, so it renders again every minute.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Composer typing signal: a start at most every 3s, one stop when typing ends.
  const lastStart = useRef(0);
  const idle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const stopTyping = useCallback(() => {
    clearTimeout(idle.current);
    if (lastStart.current === 0) return;
    lastStart.current = 0;
    onTyping(conversationId, false);
  }, [onTyping, conversationId]);
  useEffect(() => stopTyping, [stopTyping]);

  const onDraft = (text: string) => {
    setDraft(text);
    if (!text.trim()) return stopTyping();
    const at = Date.now();
    if (at - lastStart.current >= TYPING_EVERY_MS) {
      lastStart.current = at;
      onTyping(conversationId, true);
    }
    clearTimeout(idle.current);
    idle.current = setTimeout(stopTyping, TYPING_IDLE_MS);
  };
  const [older, setOlder] = useState('idle'); // 'idle', 'loading', or an error text;
  const scrollRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLLIElement>(null);
  const endRef = useRef<HTMLLIElement>(null);
  const anchor = useRef<number | null>(null);
  const list = messages.data?.messages ?? [];
  const count = list.length;
  const hasMore = messages.data?.hasMore ?? false;
  const first = list[0];
  const last = list.at(-1);
  const firstKey = first && first.senderId + first.clientId;
  const lastKey = last && last.senderId + last.clientId;

  // An older page landed on top: shift by its height so the message you were reading stays put.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && anchor.current !== null) el.scrollTop += el.scrollHeight - anchor.current;
    anchor.current = null;
  }, [firstKey]);

  // A new message at the bottom (or the first load): follow it.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [lastKey]);

  // Re-created after every load, so a sentinel that is still visible triggers the next page.
  useEffect(() => {
    const top = topRef.current;
    if (!top || !hasMore || older !== 'idle') return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting || !scrollRef.current) return;
        anchor.current = scrollRef.current.scrollHeight;
        setOlder('loading');
        loadOlder(qc, conversationId).then(
          () => setOlder('idle'),
          (e: unknown) => setOlder(describeError(e)),
        );
      },
      { root: scrollRef.current },
    );
    io.observe(top);
    return () => io.disconnect();
  }, [qc, conversationId, hasMore, older, count]);

  const deliver = async (m: ChatMessage) => {
    putMessage(qc, { ...m, status: 'sending', error: undefined });
    const ack = await send({
      conversationId: m.conversationId,
      clientId: m.clientId,
      body: m.body,
    });
    putMessage(qc, ack.ok ? ack.message : { ...m, status: 'failed', error: ack.error });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    stopTyping();
    const clientId = crypto.randomUUID();
    void deliver({
      id: `local:${clientId}`,
      conversationId,
      senderId: me.id,
      clientId,
      body,
      createdAt: new Date().toISOString(),
    });
  };

  return (
    <>
      <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md border border-slate-300 px-3 py-1 text-sm font-medium md:hidden"
        >
          Back
        </button>
        {isGroup ? (
          <>
            <div className="flex min-w-0 flex-col">
              <h2 className="truncate font-semibold">
                <button type="button" onClick={onInfo} className="truncate hover:underline">
                  {convo.name}
                </button>
              </h2>
              <span className="text-xs text-slate-500">{convo.memberCount} members</span>
            </div>
            <button
              type="button"
              onClick={onInfo}
              className="ml-auto shrink-0 rounded-md border border-slate-300 px-3 py-1 text-sm font-medium"
            >
              Info
            </button>
          </>
        ) : (
          <div className="flex min-w-0 flex-col">
            <h2 className="truncate font-semibold">{convo ? titleOf(convo) : 'Conversation'}</h2>
            {convo?.type === 'direct' && (
              <span
                className={`text-xs ${convo.peer.online ? 'text-green-700' : 'text-slate-500'}`}
              >
                {lastSeenText(convo.peer, now)}
              </span>
            )}
          </div>
        )}
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-3">
        {messages.isPending ? (
          <p className="text-sm text-slate-500">Loading messages...</p>
        ) : messages.isError ? (
          <div className="flex flex-col items-start gap-2 text-sm">
            <p className="text-red-700">Could not load messages.</p>
            <button
              type="button"
              onClick={() => void messages.refetch()}
              className="rounded-md border border-slate-300 px-3 py-1 font-medium"
            >
              Retry
            </button>
          </div>
        ) : count === 0 ? (
          <p className="text-sm text-slate-500">No messages yet. Say hello.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            <li ref={topRef} className="self-center text-xs text-slate-500">
              {!hasMore ? (
                'Start of conversation'
              ) : older === 'loading' || older === 'idle' ? (
                'Loading older...'
              ) : (
                <span className="text-red-700">
                  {older}{' '}
                  <button
                    type="button"
                    onClick={() => setOlder('idle')}
                    className="font-medium underline"
                  >
                    Retry
                  </button>
                </span>
              )}
            </li>
            {list.map((m) => {
              const mine = m.senderId === me.id;
              return (
                <li key={m.clientId + m.senderId} className={mine ? 'self-end' : 'self-start'}>
                  <div className="mb-0.5 text-xs text-slate-500">
                    {mine ? 'You' : senderName(m.senderId)} · {formatTime(m.createdAt)}
                  </div>
                  <p
                    className={`max-w-[80vw] rounded-lg px-3 py-2 break-words whitespace-pre-wrap md:max-w-md ${
                      mine ? 'bg-slate-900 text-white' : 'bg-white shadow-sm'
                    } ${m.status ? 'opacity-70' : ''}`}
                  >
                    {m.body}
                  </p>
                  {m.status === 'sending' && (
                    <div className="mt-0.5 text-right text-xs text-slate-500">Sending...</div>
                  )}
                  {m.status === 'failed' && (
                    <div className="mt-0.5 flex items-center justify-end gap-2 text-xs text-red-700">
                      <span>{failText[m.error ?? ''] ?? 'Not sent.'}</span>
                      {retryable.has(m.error ?? '') && (
                        <button
                          type="button"
                          onClick={() => void deliver(m)}
                          className="font-medium underline"
                        >
                          Retry
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
            <li ref={endRef} aria-hidden="true" />
          </ul>
        )}
      </div>
      <p role="status" className="h-5 shrink-0 truncate px-3 text-xs text-slate-500 italic">
        {typingText(typers.map(senderName))}
      </p>
      <form onSubmit={submit} className="flex gap-2 border-t border-slate-200 bg-white p-3">
        <label htmlFor="composer" className="sr-only">
          Message
        </label>
        <input
          id="composer"
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          onBlur={stopTyping}
          maxLength={4000}
          autoComplete="off"
          placeholder="Write a message"
          className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 focus:border-slate-900 focus:outline-none"
        />
        <button
          type="submit"
          disabled={!draft.trim()}
          className="rounded-md bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </>
  );
}
