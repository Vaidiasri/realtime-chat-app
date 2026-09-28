import { z } from 'zod';
import type { Message } from './conversations.js';

export type Role = 'owner' | 'admin' | 'member';
export type GroupAction = 'rename' | 'add' | 'remove' | 'leave' | 'setRole' | 'transfer' | 'delete';

export const GROUP_MAX_MEMBERS = 100;

const rank: Record<Role, number> = { owner: 3, admin: 2, member: 1 };

/**
 * The one permission rule for groups (spec 0006). The server calls it to enforce, the client only
 * to hide controls. Self rules (no role change or transfer to yourself) are identity checks and
 * live in the service; sending, reading and listing members are plain membership.
 */
export function can(action: GroupAction, actor: Role, target?: Role): boolean {
  switch (action) {
    case 'rename':
    case 'add':
      return rank[actor] >= rank.admin;
    case 'remove':
      // Strictly outrank the target: admins remove members, the Owner removes admins too.
      return target !== undefined && target !== 'owner' && rank[actor] > rank[target];
    case 'leave':
      return actor !== 'owner';
    case 'setRole':
    case 'transfer':
      return actor === 'owner' && target !== undefined && target !== 'owner';
    case 'delete':
      return actor === 'owner';
  }
}

export interface GroupSummary {
  id: string;
  type: 'group';
  name: string;
  avatarUrl: string | null;
  memberCount: number;
  myRole: Role;
  latestMessage: Message | null;
  unreadCount: number;
  createdAt: string;
}

export interface GroupMember {
  userId: string;
  displayName: string;
  role: Role;
  lastDeliveredId: string | null;
  lastReadId: string | null;
}

/** Members sorted owner, then admins, then members, each by display name. */
export interface GroupDetail {
  id: string;
  name: string;
  avatarUrl: string | null;
  members: GroupMember[];
}

export interface GroupResponse {
  group: GroupDetail;
}

export const groupName = z.string().trim().min(1).max(100);
// https only: the URL is rendered as an <img src>, never as a link, so other schemes are refused.
export const avatarUrl = z.url({ protocol: /^https$/ }).max(2048);

export const createGroupBody = z.object({
  name: groupName,
  avatarUrl: avatarUrl.optional(),
  memberIds: z
    .array(z.uuid())
    .max(GROUP_MAX_MEMBERS - 1)
    .default([]),
});
export type CreateGroupBody = z.infer<typeof createGroupBody>;

export const updateGroupBody = z
  .object({ name: groupName.optional(), avatarUrl: avatarUrl.nullable().optional() })
  .refine((b) => b.name !== undefined || b.avatarUrl !== undefined);
export type UpdateGroupBody = z.infer<typeof updateGroupBody>;

export const addMembersBody = z.object({
  userIds: z
    .array(z.uuid())
    .min(1)
    .max(GROUP_MAX_MEMBERS - 1),
});
export const setRoleBody = z.object({ role: z.enum(['admin', 'member']) });
export const transferBody = z.object({ userId: z.uuid() });
export const memberParam = z.object({ id: z.uuid(), userId: z.uuid() });

// Socket payloads: the same bodies, plus the group id.
const groupRef = z.object({ conversationId: z.uuid() });
export const groupUpdatePayload = z
  .object({
    conversationId: z.uuid(),
    name: groupName.optional(),
    avatarUrl: avatarUrl.nullable().optional(),
  })
  .refine((b) => b.name !== undefined || b.avatarUrl !== undefined);
export const groupAddPayload = groupRef.extend(addMembersBody.shape);
export const groupMemberPayload = groupRef.extend({ userId: z.uuid() });
export const groupSetRolePayload = groupMemberPayload.extend(setRoleBody.shape);
export const groupRefPayload = groupRef;

export type GroupError =
  'invalid_input' | 'not_found' | 'forbidden' | 'group_full' | 'owner_must_transfer' | 'internal';
export type GroupAck = { ok: true } | { ok: false; error: GroupError };

export interface GroupRemoved {
  conversationId: string;
  name: string;
  reason: 'removed' | 'left' | 'deleted';
}
