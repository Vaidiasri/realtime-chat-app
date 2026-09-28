import * as q from './queries.js';

const GRACE_MS = 5_000;
const TYPING_GAP_MS = 1_000;

// ponytail: presence lives in this process. Several instances need the Redis adapter and a
// shared online set.
const online = new Set<string>();
const graces = new Map<string, NodeJS.Timeout>();

export const isOnline = (userId: string) => online.has(userId);

export const lastSeen = async (userId: string) => (await q.lastSeen(userId))?.toISOString() ?? null;

/** A socket is ready. True only when contacts must hear the user came online. */
export function cameOnline(userId: string): boolean {
  const pending = graces.get(userId);
  if (pending) {
    // Back inside the grace delay: contacts never saw offline.
    clearTimeout(pending);
    graces.delete(userId);
    return false;
  }
  if (online.has(userId)) return false;
  online.add(userId);
  return true;
}

/**
 * The last socket left. After the grace delay, if none came back, the user goes offline:
 * last_seen_at is written, then `announce` tells contacts.
 */
export function wentAway(
  userId: string,
  connected: () => boolean,
  announce: (lastSeenAt: string) => void,
): void {
  clearTimeout(graces.get(userId));
  graces.set(
    userId,
    setTimeout(() => {
      graces.delete(userId);
      if (connected() || !online.delete(userId)) return;
      const at = new Date();
      void q.setLastSeen(userId, at).finally(() => announce(at.toISOString()));
    }, GRACE_MS),
  );
}

// Last accepted typing event per user, conversation and kind.
const typingSeen = new Map<string, number>();
setInterval(() => {
  const cutoff = Date.now() - TYPING_GAP_MS;
  for (const [key, at] of typingSeen) if (at <= cutoff) typingSeen.delete(key);
}, 60_000).unref();

/** At most one typing event of each kind per second per user and conversation. */
export function allowTyping(userId: string, conversationId: string, kind: 'start' | 'stop') {
  const key = `${userId}:${conversationId}:${kind}`;
  const now = Date.now();
  const last = typingSeen.get(key);
  if (last !== undefined && now - last < TYPING_GAP_MS) return false;
  typingSeen.set(key, now);
  return true;
}
