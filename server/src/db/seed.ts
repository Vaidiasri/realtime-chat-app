import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { sql } from 'kysely';
import type { Role } from './index.js';
import { db } from './index.js';
import { logger } from '../logger.js';

/** Every demo login shares this password. It is demo data, not a secret. */
export const DEMO_PASSWORD = 'password123';

const USERS = [
  ['aarav', 'Aarav Sharma'],
  ['priya', 'Priya Nair'],
  ['rahul', 'Rahul Verma'],
  ['sneha', 'Sneha Iyer'],
  ['vikram', 'Vikram Rao'],
  ['meera', 'Meera Kapoor'],
] as const;
type Handle = (typeof USERS)[number][0];
const email = (h: Handle) => `${h}@demo.chat`;

type Line = readonly [Handle, string];
const GROUPS: readonly {
  name: string;
  members: readonly (readonly [Handle, Role])[];
  lines: readonly Line[];
}[] = [
  {
    name: 'Project Phoenix',
    members: [
      ['aarav', 'owner'],
      ['priya', 'admin'],
      ['rahul', 'member'],
      ['sneha', 'member'],
      ['vikram', 'member'],
    ],
    lines: [
      ['aarav', 'Kickoff notes are in the doc. Release target is Friday.'],
      ['priya', 'I added Vikram, he is picking up the API work.'],
      ['vikram', 'Thanks! Starting on the auth endpoints today.'],
      ['rahul', 'Frontend build is green again.'],
      ['sneha', 'QA pass on staging tomorrow morning.'],
      ['aarav', 'Great. Standup moves to 10:30 this week.'],
    ],
  },
  {
    name: 'Weekend Trek',
    members: [
      ['sneha', 'owner'],
      ['meera', 'admin'],
      ['rahul', 'member'],
      ['aarav', 'member'],
    ],
    lines: [
      ['sneha', 'Trek on Saturday? Weather looks clear.'],
      ['meera', 'In! I can drive, 4 seats.'],
      ['rahul', 'Count me in. Leaving at 6?'],
      ['sneha', '6 sharp. Bring water and a jacket.'],
      ['meera', 'Booked the parking permit.'],
    ],
  },
];
const DIRECTS: readonly (readonly [Handle, Handle, readonly Line[]])[] = [
  [
    'aarav',
    'priya',
    [
      ['aarav', 'Did you get a chance to review my PR?'],
      ['priya', 'Yes, left two small comments.'],
      ['aarav', 'Fixed both, thanks!'],
      ['priya', 'Approved.'],
    ],
  ],
  [
    'rahul',
    'sneha',
    [
      ['rahul', 'Are the staging creds still the same?'],
      ['sneha', 'Rotated yesterday, check the vault.'],
      ['rahul', 'Got it, thanks.'],
    ],
  ],
  [
    'priya',
    'meera',
    [
      ['meera', 'Lunch tomorrow?'],
      ['priya', 'Sure, 1pm?'],
      ['meera', 'Perfect. The new place near the office.'],
      ['meera', 'I will book a table.'],
    ],
  ],
  [
    'aarav',
    'vikram',
    [
      ['aarav', 'Welcome to the team, Vikram!'],
      ['vikram', 'Thanks Aarav, happy to be here.'],
    ],
  ],
];
// Left unread so the badges have something to show: [conversation name or DM pair, reader, unread].
const UNREAD: readonly (readonly [string, Handle, number])[] = [
  ['Project Phoenix', 'rahul', 2],
  ['Weekend Trek', 'aarav', 3],
  ['meera:priya', 'priya', 2],
];

/** Loads the demo data once. A second run sees the first user and does nothing. */
export async function seedDemo(): Promise<void> {
  const exists = await db
    .selectFrom('users')
    .select('id')
    .where('email', '=', email(USERS[0][0]))
    .executeTakeFirst();
  if (exists) return;

  // One hash for all six: they share the demo password, and bcrypt at cost 12 is slow.
  const hash = await bcrypt.hash(DEMO_PASSWORD, 12);
  await db.transaction().execute(async (trx) => {
    const rows = await trx
      .insertInto('users')
      .values(
        USERS.map(([h, name]) => ({ email: email(h), password_hash: hash, display_name: name })),
      )
      .returning(['id', 'email'])
      .execute();
    const id = (h: Handle) => rows.find((r) => r.email === email(h))?.id ?? '';

    // History spreads over the last few hours, oldest first, so ids and times agree.
    let minutesAgo = 60 * 6;
    const conversations = [
      ...GROUPS.map((g) => ({ key: g.name, group: g.name, members: g.members, lines: g.lines })),
      ...DIRECTS.map(([a, b, lines]) => ({
        key: [a, b].sort().join(':'),
        group: null,
        members: [
          [a, 'member'],
          [b, 'member'],
        ] as const,
        lines,
      })),
    ];
    for (const c of conversations) {
      const creator = c.members[0]?.[0] ?? 'aarav';
      const { id: conversationId } = await trx
        .insertInto('conversations')
        .values(
          c.group
            ? { type: 'group', name: c.group, created_by: id(creator) }
            : {
                type: 'direct',
                direct_key: c.members
                  .map(([h]) => id(h))
                  .sort()
                  .join(':'),
                created_by: id(creator),
              },
        )
        .returning('id')
        .executeTakeFirstOrThrow();
      const ids: string[] = [];
      for (const [who, body] of c.lines) {
        minutesAgo -= 7;
        const m = await trx
          .insertInto('messages')
          .values({
            conversation_id: conversationId,
            sender_id: id(who),
            client_id: randomUUID(),
            body,
            created_at: sql`now() - make_interval(mins => ${minutesAgo})`,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        ids.push(m.id);
      }
      const latest = ids.at(-1) ?? null;
      await trx
        .insertInto('memberships')
        .values(
          c.members.map(([h, role]) => {
            const unread = UNREAD.find(([k, reader]) => k === c.key && reader === h)?.[2] ?? 0;
            return {
              conversation_id: conversationId,
              user_id: id(h),
              role,
              last_delivered_message_id: latest,
              last_read_message_id: unread ? (ids.at(-1 - unread) ?? null) : latest,
            };
          }),
        )
        .execute();
      // A reaction on the first message of each conversation, from its second member.
      const [first] = ids;
      const reactor = c.members[1]?.[0];
      if (first && reactor) {
        await trx
          .insertInto('reactions')
          .values({ message_id: first, user_id: id(reactor), emoji: '\u{1F44D}' })
          .execute();
      }
    }
  });
  logger.info(`seeded ${USERS.length} demo users, password ${DEMO_PASSWORD}`);
}
