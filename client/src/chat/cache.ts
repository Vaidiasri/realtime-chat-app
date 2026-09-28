import { useQuery, type QueryClient } from '@tanstack/react-query';
import type {
  ConversationSummary,
  ConversationsResponse,
  GroupDetail,
  GroupResponse,
  Message,
  MessagesResponse,
  PresenceUpdate,
  ReceiptUpdate,
} from '@chat/shared';
import { apiFetch } from '../api';

/** A message as the UI holds it: server rows have no status, local sends carry one. */
export type ChatMessage = Message & { status?: 'sending' | 'failed'; error?: string };

export const keys = {
  conversations: ['conversations'] as const,
  messages: (id: string) => ['messages', id] as const,
  group: (id: string) => ['group', id] as const,
};

/** The name a conversation shows: the peer for a DM, the group name otherwise. */
export const titleOf = (c: ConversationSummary) =>
  c.type === 'direct' ? c.peer.displayName : c.name;

/** The sidebar sort key: latest message time, else creation time. ISO strings sort as text. */
export const activity = (c: ConversationSummary) => c.latestMessage?.createdAt ?? c.createdAt;

export const useConversations = () =>
  useQuery({
    queryKey: keys.conversations,
    queryFn: () =>
      apiFetch<ConversationsResponse>('/api/conversations').then((r) => r.data.conversations),
  });

/** One conversation as cached: messages oldest first, and whether older pages exist. */
export interface Thread {
  messages: ChatMessage[];
  hasMore: boolean;
}

const page = (id: string, cursor = '') =>
  apiFetch<MessagesResponse>(`/api/conversations/${id}/messages${cursor}`).then((r) => r.data);

/** The newest page, plus any local sends still sending or failed, so a refetch never drops them. */
export async function fetchMessages(qc: QueryClient, id: string): Promise<Thread> {
  const data = await page(id);
  const local = (qc.getQueryData<Thread>(keys.messages(id))?.messages ?? []).filter(
    (m) => m.status && !data.messages.some((s) => sameMessage(s, m)),
  );
  return { messages: [...data.messages, ...local], hasMore: data.hasMore };
}

/** Prepends the page before the oldest loaded server message. */
export async function loadOlder(qc: QueryClient, id: string) {
  const oldest = qc.getQueryData<Thread>(keys.messages(id))?.messages.find((m) => !m.status);
  if (!oldest) return;
  const data = await page(id, `?before=${oldest.id}`);
  qc.setQueryData<Thread>(
    keys.messages(id),
    (t) =>
      t && {
        messages: [
          ...data.messages.filter((m) => !t.messages.some((x) => sameMessage(x, m))),
          ...t.messages,
        ],
        hasMore: data.hasMore,
      },
  );
}

const SYNC_PAGES = 5;

/**
 * After a (re)connect: refresh the sidebar, then fill each cached thread's gap with `after=`.
 * A gap longer than SYNC_PAGES pages resets that thread to its newest page instead.
 */
export async function syncAll(qc: QueryClient) {
  await qc.invalidateQueries({ queryKey: keys.conversations });
  // Removed or deleted while offline: drop what is cached for it, so nothing stale shows.
  const list = qc.getQueryData<ConversationSummary[]>(keys.conversations);
  if (list) {
    const known = new Set(list.map((c) => c.id));
    for (const prefix of ['messages', 'group']) {
      for (const [key] of qc.getQueriesData({ queryKey: [prefix] })) {
        if (typeof key[1] === 'string' && !known.has(key[1])) qc.removeQueries({ queryKey: key });
      }
    }
  }
  await qc.invalidateQueries({ queryKey: ['group'] });
  await Promise.all(
    qc.getQueriesData<Thread>({ queryKey: ['messages'] }).map(([key, t]) => {
      const id = key[1];
      // A failed thread keeps what it has; the next reconnect or reopen catches it up.
      return typeof id === 'string' && t
        ? syncThread(qc, id, t).catch(() => undefined)
        : Promise.resolve();
    }),
  );
}

async function syncThread(qc: QueryClient, id: string, t: Thread) {
  let last = t.messages.findLast((m) => !m.status)?.id;
  for (let i = 0; last && i < SYNC_PAGES; i++) {
    const data = await page(id, `?after=${last}`);
    for (const m of data.messages) putMessage(qc, m);
    if (!data.hasMore) {
      // Edits, deletes and reactions made while offline: refresh the newest page in place.
      // ponytail: older loaded pages stay as they were until the thread is opened again.
      for (const m of (await page(id)).messages) putMessage(qc, m);
      return;
    }
    last = data.messages.at(-1)?.id;
  }
  qc.setQueryData(keys.messages(id), await fetchMessages(qc, id));
}

// clientId is unique per sender, so this pair names one message across local and server copies.
const sameMessage = (a: Message, b: Message) =>
  a.senderId === b.senderId && a.clientId === b.clientId;

// Server rows by id (bigint strings, so compare as BigInt), local sends after them in send order.
const order = (a: ChatMessage, b: ChatMessage) => {
  if (a.status || b.status) return a.status && b.status ? 0 : a.status ? 1 : -1;
  const x = BigInt(a.id);
  const y = BigInt(b.id);
  return x < y ? -1 : x > y ? 1 : 0;
};

/** Adds or replaces a message, and moves its conversation to the top once the server has it. */
export function putMessage(qc: QueryClient, m: ChatMessage) {
  qc.setQueryData<Thread>(keys.messages(m.conversationId), (t) => {
    if (!t) return t; // not open yet: the first open fetches it
    const rest = t.messages.filter((x) => !sameMessage(x, m));
    return { ...t, messages: [...rest, m].sort(order) };
  });
  if (m.status) return;
  let known = false;
  qc.setQueryData<ConversationSummary[]>(keys.conversations, (list) =>
    list?.map((c) => {
      if (c.id !== m.conversationId) return c;
      known = true;
      // A gap fill can replay an older message; never move the preview backwards.
      return c.latestMessage && order(m, c.latestMessage) < 0 ? c : { ...c, latestMessage: m };
    }),
  );
  if (!known) void qc.invalidateQueries({ queryKey: keys.conversations });
}

export function putConversation(qc: QueryClient, c: ConversationSummary) {
  qc.setQueryData<ConversationSummary[]>(keys.conversations, (list) =>
    list?.some((x) => x.id === c.id)
      ? list.map((x) => (x.id === c.id ? c : x))
      : [c, ...(list ?? [])],
  );
}

/** Someone came online or left: patch the DM rows where they are the peer. */
export function putPresence(qc: QueryClient, p: PresenceUpdate) {
  qc.setQueryData<ConversationSummary[]>(keys.conversations, (list) =>
    list?.map((c) =>
      c.type === 'direct' && c.peer.id === p.userId
        ? { ...c, peer: { ...c.peer, online: p.online, lastSeenAt: p.lastSeenAt } }
        : c,
    ),
  );
}

/** A message from someone else arrived while its chat is not being read. */
export function bumpUnread(qc: QueryClient, conversationId: string) {
  qc.setQueryData<ConversationSummary[]>(keys.conversations, (list) =>
    list?.map((c) => (c.id === conversationId ? { ...c, unreadCount: c.unreadCount + 1 } : c)),
  );
}

/** Someone's marks moved. Mine clear the badge; others move ticks and seen counts. */
export function putReceipt(qc: QueryClient, r: ReceiptUpdate, meId: string) {
  const marks = { lastDeliveredId: r.lastDeliveredId, lastReadId: r.lastReadId };
  qc.setQueryData<ConversationSummary[]>(keys.conversations, (list) =>
    list?.map((c) => {
      if (c.id !== r.conversationId) return c;
      if (r.userId === meId) return r.lastReadId ? { ...c, unreadCount: 0 } : c;
      return c.type === 'direct' && c.peer.id === r.userId
        ? { ...c, peer: { ...c.peer, ...marks } }
        : c;
    }),
  );
  qc.setQueryData<GroupDetail>(
    keys.group(r.conversationId),
    (g) =>
      g && {
        ...g,
        members: g.members.map((m) => (m.userId === r.userId ? { ...m, ...marks } : m)),
      },
  );
}

/** True when the mark covers this message. Ids are bigint strings, so compare as BigInt. */
export const covers = (mark: string | null, id: string) =>
  mark !== null && BigInt(mark) >= BigInt(id);

export const useGroup = (id: string, enabled = true) =>
  useQuery({
    queryKey: keys.group(id),
    queryFn: () =>
      apiFetch<GroupResponse>(`/api/conversations/${id}/members`).then((r) => r.data.group),
    enabled,
  });

/** A fresh group detail: replace the cached one and patch the sidebar row to match. */
export function putGroup(qc: QueryClient, g: GroupDetail, meId: string) {
  qc.setQueryData(keys.group(g.id), g);
  const myRole = g.members.find((m) => m.userId === meId)?.role;
  qc.setQueryData<ConversationSummary[]>(keys.conversations, (list) =>
    list?.map((c) =>
      c.id === g.id && c.type === 'group'
        ? {
            ...c,
            name: g.name,
            avatarUrl: g.avatarUrl,
            memberCount: g.members.length,
            myRole: myRole ?? c.myRole,
          }
        : c,
    ),
  );
}

/** Lost access: forget the thread, the detail and the sidebar row. */
export function dropConversation(qc: QueryClient, id: string) {
  qc.removeQueries({ queryKey: keys.messages(id) });
  qc.removeQueries({ queryKey: keys.group(id) });
  qc.setQueryData<ConversationSummary[]>(keys.conversations, (list) =>
    list?.filter((c) => c.id !== id),
  );
}

const errorText: Record<string, string> = {
  rate_limited: 'Too many requests. Wait a moment and try again.',
  network: 'Cannot reach the server. Check your connection.',
  not_found: 'That is not available.',
  forbidden: 'Your role does not allow that.',
  group_full: 'A group can have at most 100 members.',
  owner_must_transfer: 'Make someone else the owner before you leave.',
  invalid_input: 'Check what you entered and try again.',
  too_late: 'A message can only be deleted within 10 minutes of sending it.',
  timeout: 'No reply from the server. Try again.',
};
export const describeError = (e: unknown) =>
  errorText[e instanceof Error ? e.message : ''] ?? 'Something went wrong. Try again.';
