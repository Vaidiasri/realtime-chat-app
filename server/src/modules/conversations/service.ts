import type { ConversationSummary, Message, MessageSendPayload } from '@chat/shared';
import { AppError } from '../../errors.js';
import * as q from './queries.js';

const HISTORY_LIMIT = 50;
const SEND_LIMIT = 20;
const SEND_WINDOW_MS = 10_000;

type MessageRow = {
  id: string;
  conversation_id: string;
  sender_id: string;
  client_id: string;
  body: string | null;
  created_at: Date;
};

// ponytail: body is null only for deleted messages, which arrive with feature 11.
const toMessage = (r: MessageRow): Message => ({
  id: r.id,
  conversationId: r.conversation_id,
  senderId: r.sender_id,
  clientId: r.client_id,
  body: r.body ?? '',
  createdAt: r.created_at.toISOString(),
});

type SummaryRow = Awaited<ReturnType<typeof q.summaries>>[number];

const toSummary = (r: SummaryRow): ConversationSummary => ({
  id: r.id,
  type: 'direct',
  peer: { id: r.peer_id, displayName: r.peer_name },
  latestMessage:
    r.m_id && r.m_sender_id && r.m_client_id && r.m_created_at
      ? toMessage({
          id: r.m_id,
          conversation_id: r.id,
          sender_id: r.m_sender_id,
          client_id: r.m_client_id,
          body: r.m_body,
          created_at: r.m_created_at,
        })
      : null,
  createdAt: r.created_at.toISOString(),
});

/**
 * The one membership rule for REST and sockets. Non members, unknown ids and malformed ids all
 * get the same 404, so probing reveals nothing.
 */
export async function assertMember(userId: string, conversationId: string): Promise<void> {
  if (!(await q.isMember(userId, conversationId))) throw new AppError('not_found', 404);
}

export const conversationIdsFor = (userId: string) => q.conversationIdsFor(userId);

// ponytail: in memory fixed window per instance, like the auth limits; shared store to scale out.
const sendWindows = new Map<string, { count: number; resetAt: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [key, w] of sendWindows) if (w.resetAt <= now) sendWindows.delete(key);
}, 60_000).unref();

function takeSendSlot(userId: string): void {
  const now = Date.now();
  const w = sendWindows.get(userId);
  if (!w || w.resetAt <= now) {
    sendWindows.set(userId, { count: 1, resetAt: now + SEND_WINDOW_MS });
    return;
  }
  if (w.count >= SEND_LIMIT) throw new AppError('rate_limited', 429);
  sendWindows.set(userId, { count: w.count + 1, resetAt: w.resetAt });
}

/** `created` is false for a retry of a stored message: the caller must not broadcast it again. */
export async function sendMessage(
  userId: string,
  input: MessageSendPayload,
): Promise<{ message: Message; created: boolean }> {
  takeSendSlot(userId);
  await assertMember(userId, input.conversationId);
  const { row, created } = await q.insertMessage(
    userId,
    input.conversationId,
    input.clientId,
    input.body,
  );
  // A client id reused in another conversation is a client bug, not a retry.
  if (row.conversation_id !== input.conversationId) throw new AppError('invalid_input', 400);
  return { message: toMessage(row), created };
}

export async function summaryFor(userId: string, conversationId: string) {
  const [row] = await q.summaries(userId, conversationId);
  if (!row) throw new AppError('not_found', 404);
  return toSummary(row);
}

export async function startDirect(
  me: string,
  other: string,
): Promise<{ conversation: ConversationSummary; created: boolean }> {
  if (me === other) throw new AppError('invalid_input', 400);
  const directKey = [me, other].sort().join(':');
  let started: { id: string; created: boolean };
  try {
    started = await q.startDirect(me, other, directKey);
  } catch (err) {
    // Only the membership insert can hit a FK (the other user); `me` is the verified caller.
    // Keep this mapping tied to that statement: do not widen it to other queries.
    if ((err as { code?: unknown }).code === '23503') throw new AppError('not_found', 404);
    throw err;
  }
  return { conversation: await summaryFor(me, started.id), created: started.created };
}

export async function listConversations(userId: string): Promise<ConversationSummary[]> {
  return (await q.summaries(userId)).map(toSummary);
}

export async function history(userId: string, conversationId: string): Promise<Message[]> {
  await assertMember(userId, conversationId);
  return (await q.latestMessages(conversationId, HISTORY_LIMIT)).map(toMessage).reverse();
}
