import { useQuery, type QueryClient } from '@tanstack/react-query';
import type {
  ConversationSummary,
  ConversationsResponse,
  Message,
  MessagesResponse,
} from '@chat/shared';
import { apiFetch } from '../api';

/** A message as the UI holds it: server rows have no status, local sends carry one. */
export type ChatMessage = Message & { status?: 'sending' | 'failed'; error?: string };

export const keys = {
  conversations: ['conversations'] as const,
  messages: (id: string) => ['messages', id] as const,
};

/** The sidebar sort key: latest message time, else creation time. ISO strings sort as text. */
export const activity = (c: ConversationSummary) => c.latestMessage?.createdAt ?? c.createdAt;

export const useConversations = () =>
  useQuery({
    queryKey: keys.conversations,
    queryFn: () =>
      apiFetch<ConversationsResponse>('/api/conversations').then((r) => r.data.conversations),
  });

/** Server history, plus any local sends still sending or failed, so a refetch never drops them. */
export async function fetchMessages(qc: QueryClient, id: string): Promise<ChatMessage[]> {
  const { data } = await apiFetch<MessagesResponse>(`/api/conversations/${id}/messages`);
  const local = (qc.getQueryData<ChatMessage[]>(keys.messages(id)) ?? []).filter(
    (m) => m.status && !data.messages.some((s) => sameMessage(s, m)),
  );
  return [...data.messages, ...local];
}

// clientId is unique per sender, so this pair names one message across local and server copies.
const sameMessage = (a: Message, b: Message) =>
  a.senderId === b.senderId && a.clientId === b.clientId;

/** Adds or replaces a message, and moves its conversation to the top once the server has it. */
export function putMessage(qc: QueryClient, m: ChatMessage) {
  qc.setQueryData<ChatMessage[]>(keys.messages(m.conversationId), (list) => {
    if (!list) return list; // not open yet: the first open fetches it
    return list.some((x) => sameMessage(x, m))
      ? list.map((x) => (sameMessage(x, m) ? m : x))
      : [...list, m];
  });
  if (m.status) return;
  let known = false;
  qc.setQueryData<ConversationSummary[]>(keys.conversations, (list) =>
    list?.map((c) => {
      if (c.id !== m.conversationId) return c;
      known = true;
      return { ...c, latestMessage: m };
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

const errorText: Record<string, string> = {
  rate_limited: 'Too many requests. Wait a moment and try again.',
  network: 'Cannot reach the server. Check your connection.',
  not_found: 'That is not available.',
};
export const describeError = (e: unknown) =>
  errorText[e instanceof Error ? e.message : ''] ?? 'Something went wrong. Try again.';
