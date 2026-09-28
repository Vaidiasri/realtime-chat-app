import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TYPES,
  DELETE_WINDOW_MS,
  REACTIONS,
  type Attachment,
  type AttachmentResponse,
  type DirectSummary,
  type MessageSendPayload,
  type UserSummary,
} from '@chat/shared';
import { authedFetch } from '../api';
import type { ActionResult, MessageAction, SendResult } from '../socket';
import { AttachmentView } from './Attachment';
import {
  covers,
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
  act: (a: MessageAction) => Promise<ActionResult>;
  typers: string[];
  onTyping: (conversationId: string, on: boolean) => void;
  onRead: (conversationId: string, messageId: string, kind: 'read') => void;
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

export function ChatPane({
  conversationId,
  me,
  send,
  act,
  typers,
  onTyping,
  onRead,
  onBack,
  onInfo,
}: Props) {
  const qc = useQueryClient();
  const convo = useConversations().data?.find((c) => c.id === conversationId);
  const isGroup = convo?.type === 'group';
  const group = useGroup(conversationId, isGroup);
  // Someone who left keeps their messages; their name is gone with the membership.
  const senderName = (id: string) =>
    convo?.type === 'direct'
      ? convo.peer.displayName
      : (group.data?.members.find((m) => m.userId === id)?.displayName ?? 'Former member');
  const senderNameOrYou = (id: string) => (id === me.id ? 'You' : senderName(id));
  const messages = useQuery({
    queryKey: keys.messages(conversationId),
    queryFn: () => fetchMessages(qc, conversationId),
    // Never refetch on its own: that would drop loaded older pages. Sockets and syncAll keep it fresh.
    staleTime: Infinity,
  });
  const [draft, setDraft] = useState('');
  const [fileError, setFileError] = useState('');
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [picker, setPicker] = useState<string | null>(null); // message id with the emoji row open
  const [actionError, setActionError] = useState('');

  // The server rule decides; the ack carries the message as it now stands.
  const run = async (a: MessageAction) => {
    setActionError('');
    const ack = await act(a);
    if (ack.ok) putMessage(qc, ack.message);
    else setActionError(describeError(new Error(ack.error)));
    return ack.ok;
  };
  const saveEdit = async (e: FormEvent) => {
    e.preventDefault();
    const body = editing?.text.trim();
    if (!editing || !body) return;
    if (await run({ event: 'message:edit', payload: { messageId: editing.id, body } })) {
      setEditing(null);
    }
  };
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
  const newestId = list.findLast((m) => !m.status)?.id;

  // Open and visible means read, up to the newest loaded message.
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  useEffect(() => {
    if (visible && newestId) onRead(conversationId, newestId, 'read');
  }, [visible, newestId, conversationId, onRead]);

  // DM: the peer's marks give each of my messages its tick. Group: members other than me.
  const others = group.data?.members.filter((u) => u.userId !== me.id) ?? [];
  const receipt = (id: string) => {
    if (convo?.type === 'direct') {
      const status = covers(convo.peer.lastReadId, id)
        ? 'Read'
        : covers(convo.peer.lastDeliveredId, id)
          ? 'Delivered'
          : 'Sent';
      return (
        <div className="mt-0.5 text-right text-xs">
          <span
            aria-hidden="true"
            className={status === 'Read' ? 'font-semibold text-sky-600' : 'text-slate-500'}
          >
            {status === 'Sent' ? '\u2713' : '\u2713\u2713'}
          </span>
          <span className="sr-only">{status}</span>
        </div>
      );
    }
    if (!group.data) return null;
    const seen = others.filter((u) => covers(u.lastReadId, id)).map((u) => u.displayName);
    return (
      <div
        className="mt-0.5 text-right text-xs text-slate-500"
        title={seen.length ? seen.join(', ') : undefined}
      >
        Seen by {seen.length} of {others.length}
        {seen.length > 0 && <span className="sr-only">: {seen.join(', ')}</span>}
      </div>
    );
  };
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
      body: m.body ?? '',
      attachmentId: m.attachment?.id,
    });
    putMessage(qc, ack.ok ? ack.message : { ...m, status: 'failed', error: ack.error });
  };

  const post = (body: string, attachment: Attachment | null) => {
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
      editedAt: null,
      deletedAt: null,
      reactions: [],
      attachment,
    });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = draft.trim();
    if (body) post(body, null);
  };

  // Uploads first, then sends the message that claims it, with the draft as its caption.
  // The server checks type and size again; these checks only save a doomed upload.
  const attach = async (file: File) => {
    setFileError('');
    if (!(ATTACHMENT_TYPES as readonly string[]).includes(file.type)) {
      return setFileError(describeError(new Error('unsupported_type')));
    }
    if (file.size === 0 || file.size > ATTACHMENT_MAX_BYTES) {
      return setFileError(describeError(new Error('too_large')));
    }
    try {
      const res = await authedFetch(
        `/api/conversations/${conversationId}/attachments?name=${encodeURIComponent(file.name)}`,
        { method: 'POST', headers: { 'Content-Type': file.type }, body: file },
      );
      post(draft.trim(), ((await res.json()) as AttachmentResponse).attachment);
    } catch (e) {
      setFileError(describeError(e));
    }
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
              const live = !m.status && !m.deletedAt;
              const canDelete = mine && now - Date.parse(m.createdAt) < DELETE_WINDOW_MS;
              return (
                <li
                  key={m.clientId + m.senderId}
                  className={`group ${mine ? 'self-end' : 'self-start'}`}
                >
                  <div className="mb-0.5 text-xs text-slate-500">
                    {mine ? 'You' : senderName(m.senderId)} · {formatTime(m.createdAt)}
                    {m.editedAt && !m.deletedAt && ' · edited'}
                  </div>
                  {editing?.id === m.id ? (
                    <form onSubmit={(e) => void saveEdit(e)} className="flex gap-2">
                      <label htmlFor={`edit-${m.id}`} className="sr-only">
                        Edit message
                      </label>
                      <input
                        id={`edit-${m.id}`}
                        autoFocus
                        value={editing.text}
                        maxLength={4000}
                        onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                        onKeyDown={(e) => e.key === 'Escape' && setEditing(null)}
                        className="min-w-0 rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-slate-900 focus:outline-none md:w-80"
                      />
                      <button
                        type="submit"
                        disabled={!editing.text.trim()}
                        className="rounded-md bg-slate-900 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditing(null)}
                        className="rounded-md border border-slate-300 px-3 py-1 text-sm font-medium"
                      >
                        Cancel
                      </button>
                    </form>
                  ) : m.deletedAt ? (
                    <p className="rounded-lg border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-500 italic">
                      This message was deleted
                    </p>
                  ) : (
                    <div
                      className={`max-w-[80vw] space-y-2 rounded-lg px-3 py-2 break-words whitespace-pre-wrap md:max-w-md ${
                        mine ? 'bg-slate-900 text-white' : 'bg-white shadow-sm'
                      } ${m.status ? 'opacity-70' : ''}`}
                    >
                      {m.attachment && (
                        <AttachmentView conversationId={conversationId} file={m.attachment} />
                      )}
                      {m.body && <p>{m.body}</p>}
                    </div>
                  )}
                  {live && m.reactions.length > 0 && (
                    <div className={`mt-1 flex flex-wrap gap-1 ${mine ? 'justify-end' : ''}`}>
                      {m.reactions.map((r) => {
                        const on = r.userIds.includes(me.id);
                        return (
                          <button
                            key={r.emoji}
                            type="button"
                            aria-pressed={on}
                            aria-label={`${r.emoji} ${r.userIds.length}, ${on ? 'remove yours' : 'add yours'}`}
                            title={r.userIds.map(senderNameOrYou).join(', ')}
                            onClick={() =>
                              void run({
                                event: 'message:react',
                                payload: {
                                  messageId: m.id,
                                  emoji: r.emoji as (typeof REACTIONS)[number],
                                  on: !on,
                                },
                              })
                            }
                            className={`rounded-full border px-2 text-sm ${
                              on ? 'border-sky-600 bg-sky-50' : 'border-slate-300 bg-white'
                            }`}
                          >
                            {r.emoji} {r.userIds.length}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {live && editing?.id !== m.id && (
                    <div
                      className={`mt-0.5 flex flex-wrap gap-2 text-xs text-slate-500 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100 ${
                        mine ? 'justify-end' : ''
                      }`}
                    >
                      <button
                        type="button"
                        aria-expanded={picker === m.id}
                        onClick={() => setPicker(picker === m.id ? null : m.id)}
                        className="underline"
                      >
                        React
                      </button>
                      {mine && (
                        <button
                          type="button"
                          onClick={() => {
                            setPicker(null);
                            setEditing({ id: m.id, text: m.body });
                          }}
                          className="underline"
                        >
                          Edit
                        </button>
                      )}
                      {canDelete && (
                        <button
                          type="button"
                          onClick={() => {
                            if (window.confirm('Delete this message for everyone?')) {
                              void run({ event: 'message:delete', payload: { messageId: m.id } });
                            }
                          }}
                          className="text-red-700 underline"
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  )}
                  {live && picker === m.id && (
                    <div
                      role="group"
                      aria-label="Add a reaction"
                      className={`mt-1 flex gap-1 ${mine ? 'justify-end' : ''}`}
                    >
                      {REACTIONS.map((emoji) => (
                        <button
                          key={emoji}
                          type="button"
                          onClick={() => {
                            setPicker(null);
                            void run({
                              event: 'message:react',
                              payload: { messageId: m.id, emoji, on: true },
                            });
                          }}
                          className="rounded-md border border-slate-300 bg-white px-1.5 text-lg"
                        >
                          {emoji}
                        </button>
                      ))}
                    </div>
                  )}
                  {mine && !m.status && receipt(m.id)}
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
      {actionError && (
        <p role="alert" className="flex items-center gap-2 px-3 text-xs text-red-700">
          {actionError}
          <button type="button" onClick={() => setActionError('')} className="underline">
            Dismiss
          </button>
        </p>
      )}
      <p role="status" className="h-5 shrink-0 truncate px-3 text-xs text-slate-500 italic">
        {typingText(typers.map(senderName))}
      </p>
      {fileError && (
        <p role="alert" className="bg-red-50 px-3 py-1 text-sm text-red-700">
          {fileError}
        </p>
      )}
      <form onSubmit={submit} className="flex gap-2 border-t border-slate-200 bg-white p-3">
        <label className="flex cursor-pointer items-center rounded-md border border-slate-300 px-3 py-2 text-sm font-medium focus-within:border-slate-900">
          Attach
          <input
            type="file"
            accept={ATTACHMENT_TYPES.join(',')}
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void attach(file);
            }}
          />
        </label>
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
