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
import {
  Check,
  CheckCheck,
  ChevronLeft,
  Info,
  MoreHorizontal,
  Paperclip,
  Pencil,
  SendHorizontal,
  SmilePlus,
  Trash2,
} from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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
import { Avatar, formatTime } from './Sidebar';

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
      const Tick = status === 'Sent' ? Check : CheckCheck;
      return (
        <div className="mt-1 flex justify-end px-1">
          <Tick
            aria-hidden="true"
            className={`size-3.5 ${status === 'Read' ? 'text-primary' : 'text-muted-foreground'}`}
          />
          <span className="sr-only">{status}</span>
        </div>
      );
    }
    if (!group.data) return null;
    const seen = others.filter((u) => covers(u.lastReadId, id)).map((u) => u.displayName);
    return (
      <div
        className="mt-1 px-1 text-right text-[11px] text-muted-foreground"
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
      <header className="flex h-16 shrink-0 items-center gap-3 border-b px-3 md:px-5">
        <Button
          variant="ghost"
          size="icon"
          onClick={onBack}
          aria-label="Back"
          className="md:hidden"
        >
          <ChevronLeft />
        </Button>
        {convo && <Avatar name={titleOf(convo)} url={isGroup ? convo.avatarUrl : null} />}
        {isGroup ? (
          <>
            <div className="flex min-w-0 flex-col">
              <h2 className="truncate text-sm font-semibold">
                <button
                  type="button"
                  onClick={onInfo}
                  className="truncate rounded-sm underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  {convo.name}
                </button>
              </h2>
              <span className="text-xs text-muted-foreground">{convo.memberCount} members</span>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onInfo}
                  aria-label="Info"
                  className="ml-auto shrink-0"
                >
                  <Info />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Group info</TooltipContent>
            </Tooltip>
          </>
        ) : (
          <div className="flex min-w-0 flex-col">
            <h2 className="truncate text-sm font-semibold">
              {convo ? titleOf(convo) : 'Conversation'}
            </h2>
            {convo?.type === 'direct' && (
              <span
                className={`text-xs ${convo.peer.online ? 'text-success' : 'text-muted-foreground'}`}
              >
                {lastSeenText(convo.peer, now)}
              </span>
            )}
          </div>
        )}
      </header>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-5 md:px-6">
        {messages.isPending ? (
          <div aria-label="Loading messages" className="flex flex-col gap-4">
            <Skeleton className="h-10 w-48 rounded-2xl" />
            <Skeleton className="h-14 w-64 self-end rounded-2xl" />
            <Skeleton className="h-10 w-40 rounded-2xl" />
            <Skeleton className="h-10 w-56 self-end rounded-2xl" />
          </div>
        ) : messages.isError ? (
          <div className="flex flex-col items-center gap-3 py-10 text-sm">
            <p className="text-destructive">Could not load messages.</p>
            <Button variant="outline" size="sm" onClick={() => void messages.refetch()}>
              Retry
            </Button>
          </div>
        ) : count === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No messages yet. Say hello.
          </p>
        ) : (
          <ul className="mx-auto flex max-w-3xl flex-col gap-3">
            <li
              ref={topRef}
              className="self-center rounded-full bg-muted px-3 py-0.5 text-[11px] text-muted-foreground"
            >
              {!hasMore ? (
                'Start of conversation'
              ) : older === 'loading' || older === 'idle' ? (
                'Loading older...'
              ) : (
                <span className="text-destructive">
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
                  className={`group flex max-w-full flex-col ${mine ? 'items-end self-end' : 'items-start self-start'}`}
                >
                  <div className="mb-1 px-1 text-[11px] text-muted-foreground">
                    {mine ? 'You' : senderName(m.senderId)} · {formatTime(m.createdAt)}
                    {m.editedAt && !m.deletedAt && ' · edited'}
                  </div>
                  {editing?.id === m.id ? (
                    <form onSubmit={(e) => void saveEdit(e)} className="flex w-full gap-2">
                      <label htmlFor={`edit-${m.id}`} className="sr-only">
                        Edit message
                      </label>
                      <Input
                        id={`edit-${m.id}`}
                        autoFocus
                        value={editing.text}
                        maxLength={4000}
                        onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                        onKeyDown={(e) => e.key === 'Escape' && setEditing(null)}
                        className="h-9 min-w-0 md:w-80"
                      />
                      <Button type="submit" size="lg" disabled={!editing.text.trim()}>
                        Save
                      </Button>
                      <Button
                        type="button"
                        size="lg"
                        variant="ghost"
                        onClick={() => setEditing(null)}
                      >
                        Cancel
                      </Button>
                    </form>
                  ) : m.deletedAt ? (
                    <p className="rounded-2xl border border-dashed px-3.5 py-2 text-sm text-muted-foreground italic">
                      This message was deleted
                    </p>
                  ) : (
                    <div className="relative max-w-full">
                      <div
                        className={`max-w-[78vw] space-y-2 rounded-2xl px-3.5 py-2 text-[15px] leading-relaxed break-words whitespace-pre-wrap md:max-w-md ${
                          mine
                            ? 'rounded-br-md bg-primary text-primary-foreground'
                            : 'rounded-bl-md bg-bubble shadow-xs ring-1 ring-foreground/8'
                        } ${m.status ? 'opacity-70' : ''}`}
                      >
                        {m.attachment && (
                          <AttachmentView conversationId={conversationId} file={m.attachment} />
                        )}
                        {m.body && <p>{m.body}</p>}
                      </div>
                      {live && (
                        <div
                          className={`absolute top-1/2 flex -translate-y-1/2 items-center gap-0.5 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 has-data-[state=open]:opacity-100 [@media(hover:hover)]:opacity-0 ${
                            mine ? 'right-full mr-1 flex-row-reverse' : 'left-full ml-1'
                          }`}
                        >
                          <Popover
                            open={picker === m.id}
                            onOpenChange={(o) => setPicker(o ? m.id : null)}
                          >
                            <PopoverTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label="React"
                                className="text-muted-foreground"
                              >
                                <SmilePlus />
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent
                              side="top"
                              align={mine ? 'end' : 'start'}
                              className="w-auto flex-row gap-0.5 rounded-full p-1"
                            >
                              <div
                                role="group"
                                aria-label="Add a reaction"
                                className="flex gap-0.5"
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
                                    className="flex size-9 items-center justify-center rounded-full text-xl transition-transform duration-150 ease-out hover:scale-115 hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                                  >
                                    {emoji}
                                  </button>
                                ))}
                              </div>
                            </PopoverContent>
                          </Popover>
                          {(mine || canDelete) && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label="More actions"
                                  className="text-muted-foreground"
                                >
                                  <MoreHorizontal />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent
                                align={mine ? 'end' : 'start'}
                                className="w-40"
                                // Let the edit field keep the focus it grabs.
                                onCloseAutoFocus={(e) => e.preventDefault()}
                              >
                                {mine && (
                                  <DropdownMenuItem
                                    onSelect={() => {
                                      setPicker(null);
                                      setEditing({ id: m.id, text: m.body });
                                    }}
                                  >
                                    <Pencil />
                                    Edit
                                  </DropdownMenuItem>
                                )}
                                {canDelete && (
                                  <DropdownMenuItem
                                    variant="destructive"
                                    onSelect={() => {
                                      if (window.confirm('Delete this message for everyone?')) {
                                        void run({
                                          event: 'message:delete',
                                          payload: { messageId: m.id },
                                        });
                                      }
                                    }}
                                  >
                                    <Trash2 />
                                    Delete
                                  </DropdownMenuItem>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </div>
                      )}
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
                            className={`flex h-6 items-center gap-1 rounded-full border px-2 text-xs font-medium tabular-nums transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none ${
                              on
                                ? 'border-primary/40 bg-primary/10 text-primary'
                                : 'bg-background hover:bg-accent'
                            }`}
                          >
                            {r.emoji} {r.userIds.length}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {mine && !m.status && receipt(m.id)}
                  {m.status === 'sending' && (
                    <div className="mt-1 px-1 text-right text-[11px] text-muted-foreground">
                      Sending...
                    </div>
                  )}
                  {m.status === 'failed' && (
                    <div className="mt-1 flex items-center justify-end gap-2 px-1 text-xs text-destructive">
                      <span>{failText[m.error ?? ''] ?? 'Not sent.'}</span>
                      {retryable.has(m.error ?? '') && (
                        <button
                          type="button"
                          onClick={() => void deliver(m)}
                          className="font-medium underline underline-offset-2"
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
        <p role="alert" className="flex items-center gap-2 px-5 text-xs text-destructive">
          {actionError}
          <button type="button" onClick={() => setActionError('')} className="underline">
            Dismiss
          </button>
        </p>
      )}
      <p role="status" className="h-5 shrink-0 truncate px-5 text-xs text-muted-foreground italic">
        {typingText(typers.map(senderName))}
      </p>
      {fileError && (
        <p
          role="alert"
          className="mx-3 rounded-lg bg-destructive/10 px-3 py-1.5 text-sm text-destructive"
        >
          {fileError}
        </p>
      )}
      <form
        onSubmit={submit}
        className="flex shrink-0 items-center gap-2 px-3 pt-1 pb-3 md:px-5 md:pb-4"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <label
              className={buttonVariants({
                variant: 'ghost',
                size: 'icon-lg',
                className:
                  'size-10 shrink-0 cursor-pointer rounded-full text-muted-foreground focus-within:ring-3 focus-within:ring-ring/50',
              })}
            >
              <Paperclip />
              <span className="sr-only">Attach</span>
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
          </TooltipTrigger>
          <TooltipContent>Attach a file</TooltipContent>
        </Tooltip>
        <label htmlFor="composer" className="sr-only">
          Message
        </label>
        <Input
          id="composer"
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          onBlur={stopTyping}
          maxLength={4000}
          autoComplete="off"
          placeholder="Write a message"
          className="h-10 min-w-0 flex-1 rounded-full border-transparent bg-muted px-4 dark:bg-muted"
        />
        <Button
          type="submit"
          size="icon-lg"
          disabled={!draft.trim()}
          aria-label="Send"
          className="size-10 shrink-0 rounded-full"
        >
          <SendHorizontal />
        </Button>
      </form>
    </>
  );
}
