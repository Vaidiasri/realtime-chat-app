# Realtime Chat

A realtime chat app with one to one messages and group chats with roles. Every REST call and
every socket event checks who the user is and whether they are allowed to do it.

**Live demo:** https://realtime-chat-f85i.onrender.com (free tier: the first load after idle can take about a minute) · Demo logins: `aarav@demo.chat`, `priya@demo.chat`,
`rahul@demo.chat`, `sneha@demo.chat`, `vikram@demo.chat`, `meera@demo.chat`, all with the
password `password123` (demo data, not a secret).

**Stack:** React 19 + Vite + Tailwind 4, Express 5 + Socket.io 4 on one port, Postgres 17 with
Kysely, TypeScript everywhere, npm workspaces (`shared`, `server`, `client`). Zod schemas in
`shared` validate every request and socket payload on the server, and both sides import the same
event types.

## Features

- Signup and login, bcrypt passwords, short lived JWT access token, rotating refresh token in an
  httpOnly cookie with reuse detection.
- Socket auth at the handshake, and a per socket deadline so no socket outlives its token.
- User search and one to one chats (one conversation per pair, enforced by the database).
- Groups with Owner, Admin and Member roles, enforced on REST and sockets. A removed member
  stops getting messages at once.
- Messages stored in Postgres, cursor pagination upward, offline delivery, idempotent retries
  through client generated message ids.
- Presence with last seen (multi tab aware), throttled typing indicators.
- Sent, delivered and read ticks for DMs, "Seen by X of Y" for groups, live unread counts.
- Edit (marked edited), delete for everyone within 10 minutes, emoji reactions, all live.
- Responsive layout, a "Reconnecting..." banner, and missed messages synced on reconnect.
- Bonus: image and file sharing with type and size checks, dark mode, and tests for the group
  permission rules.

## Run it

### With Docker (recommended)

```bash
docker compose up --build
```

Open http://localhost:3000. No `.env` is needed: compose has dev defaults, runs the migrations,
and seeds the demo data (6 users, 2 groups, DMs with history) on first boot.

### On the host, for development

```bash
npm install
cp .env.example .env
docker compose up -d db        # Postgres only
npm run dev                    # API on :3000, Vite on :5173
```

Open http://localhost:5173. Tip: set `ACCESS_TOKEN_TTL_SECONDS=20` in `.env` to watch the socket
token refresh happen.

### Checks

```bash
npm run lint
npm run typecheck
npm test          # needs the db container: runs against a separate chat_test database
```

### Deploy (Render)

`render.yaml` is a Render Blueprint: one Docker web service plus a free Postgres 17. In the
Render dashboard pick **New > Blueprint**, connect this repo, and apply. Render generates
`JWT_ACCESS_SECRET`, wires `DATABASE_URL`, and the first boot migrates and seeds.

## Database schema

Rules the database can enforce are constraints, not app checks.

| Table            | Purpose                      | Key columns and constraints                                                                                                                              |
| ---------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`          | Accounts                     | `email` UNIQUE and stored lowercase, `password_hash` (bcrypt), `display_name`, `last_seen_at`                                                            |
| `refresh_tokens` | One row per refresh token    | `token_hash` UNIQUE (only a SHA hash is stored), `session_id` (shared by every rotation of one login), `expires_at`, `revoked_at`, `replaced_by`         |
| `conversations`  | DMs and groups               | `type` is `direct` or `group`. `direct_key` UNIQUE (the two user ids, sorted). A CHECK makes a DM have a key and no name, and a group the reverse        |
| `memberships`    | Who is in which conversation | PK `(conversation_id, user_id)`, `role` is owner, admin or member, `last_delivered_message_id`, `last_read_message_id`                                   |
| `messages`       | Chat messages                | `id` bigint identity (the cursor), `client_id`, `body`, `edited_at`, `deleted_at`. UNIQUE `(sender_id, client_id)`. A CHECK ties a null body to deletion |
| `reactions`      | Emoji reactions              | PK `(message_id, user_id, emoji)`                                                                                                                        |
| `attachments`    | Shared files                 | `data` bytea, `mime`, `size` (CHECK 1 byte to 5 MB), `message_id` UNIQUE (null until a message claims it)                                                |

Relations: `memberships`, `messages` and `attachments` reference `conversations` with
`ON DELETE CASCADE`, so deleting a group removes everything in it. `reactions` and
`attachments` cascade from `messages`. Read marks use `ON DELETE SET NULL`.

### Indexes and why

| Index                                                             | Why                                                                                                                                                 |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `messages (conversation_id, id DESC)`                             | The one hot path: history pages (`id < cursor`), reconnect gap fill (`id > last`), the latest message in the sidebar, and unread counts all scan it |
| `messages UNIQUE (sender_id, client_id)`                          | Idempotent send. A retry hits the constraint (`ON CONFLICT DO NOTHING`) and gets the stored row back, so no duplicate                               |
| `conversations UNIQUE (direct_key)`                               | Exactly one DM per pair, even when both users click at the same moment                                                                              |
| `memberships (user_id)`                                           | "My conversations", which runs on every connect and sidebar load. The PK already covers lookups by conversation                                     |
| `memberships UNIQUE (conversation_id) WHERE role = 'owner'`       | A partial unique index: a group can never have two owners                                                                                           |
| `refresh_tokens (user_id)`, `(session_id)`, `UNIQUE (token_hash)` | Token lookup on refresh, and revoking a whole session when a reused token is detected                                                               |
| `attachments UNIQUE (message_id)`                                 | One file per message, and fast lookup when a page of messages loads                                                                                 |

Message ids are a bigint identity, not a timestamp, so the cursor is strictly ordered with no ties.

## Socket events

Every client event is parsed with its zod schema before anything runs. Events with an ack reply
`{ ok: true, ... }` or `{ ok: false, error: code }`, and never a stack trace.

**Rooms:** `user:<userId>` (all tabs of a user), `session:<sid>` (one login), and
`conv:<conversationId>` (members of a conversation). The server joins sockets to rooms. There is
no client event to join a room.

### Client to server

| Event                          | Payload                                                      | Who may emit                                                                                                                                               | Ack                             |
| ------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `auth:refresh`                 | `{ token }` (a fresh access token)                           | The socket's own user, same session                                                                                                                        | `{ ok }`. A failure disconnects |
| `message:send`                 | `{ conversationId, clientId, body, attachmentId? }`          | Members of the conversation                                                                                                                                | `{ ok, message }`               |
| `message:edit`                 | `{ messageId, body }`                                        | The sender, on a message not deleted                                                                                                                       | `{ ok, message }`               |
| `message:delete`               | `{ messageId }`                                              | The sender, within 10 minutes                                                                                                                              | `{ ok, message }`               |
| `message:react`                | `{ messageId, emoji, on }`                                   | Members                                                                                                                                                    | `{ ok, message }`               |
| `group:create`                 | `{ name, avatarUrl?, memberIds? }`                           | Any user (becomes Owner)                                                                                                                                   | `{ ok }`                        |
| `group:update`                 | `{ conversationId, name?, avatarUrl? }`                      | Owner, Admin                                                                                                                                               | `{ ok }`                        |
| `group:addMembers`             | `{ conversationId, userIds }`                                | Owner, Admin                                                                                                                                               | `{ ok }`                        |
| `group:removeMember`           | `{ conversationId, userId }`                                 | Owner, Admin (an Admin cannot remove the Owner or another Admin). Anyone but the Owner may remove themselves, which is leaving (the Owner transfers first) | `{ ok }`                        |
| `group:setRole`                | `{ conversationId, userId, role: 'admin' or 'member' }`      | Owner                                                                                                                                                      | `{ ok }`                        |
| `group:transfer`               | `{ conversationId, userId }`                                 | Owner                                                                                                                                                      | `{ ok }`                        |
| `group:delete`                 | `{ conversationId }`                                         | Owner                                                                                                                                                      | `{ ok }`                        |
| `typing:start` / `typing:stop` | `{ conversationId }`                                         | Members. Throttled to one per second per conversation. Non members are dropped silently                                                                    | none                            |
| `receipt:mark`                 | `{ conversationId, messageId, kind: 'delivered' or 'read' }` | Members. Marks only move forward                                                                                                                           | none                            |

### Server to client

| Event              | Payload                                                            | Who receives it                                        |
| ------------------ | ------------------------------------------------------------------ | ------------------------------------------------------ |
| `message:new`      | `Message`                                                          | `conv:<id>` except the sending socket (it got the ack) |
| `message:updated`  | `Message` (after an edit, delete or reaction)                      | `conv:<id>`, including the actor's other tabs          |
| `conversation:new` | `ConversationSummary`                                              | `user:<id>` for someone added to a group or a new DM   |
| `group:updated`    | `GroupDetail` (members and roles)                                  | `conv:<id>`                                            |
| `group:removed`    | `{ conversationId, name, reason: 'removed', 'left' or 'deleted' }` | `user:<id>` of each person who lost access             |
| `presence:update`  | `{ userId, online, lastSeenAt }`                                   | Every conversation room the user is in                 |
| `typing:update`    | `{ conversationId, userId, typing }`                               | `conv:<id>` except the typer's socket                  |
| `receipt:update`   | `{ conversationId, userId, lastDeliveredId, lastReadId }`          | `conv:<id>`                                            |

Group changes also have REST routes (`/api/conversations/groups`, `/:id/members`, and so on).
REST and sockets call the same service functions, so the rules exist once.

## How authorization works for sockets

1. **Handshake.** The client passes its access token in `auth.token`. Middleware verifies the
   JWT signature and expiry (`jose`) and checks that its session is still live. On failure the
   connection is refused with `unauthorized`, so it never reaches any handler. The verified user
   id is stored in `socket.data`. The server never reads a user id from a payload.
2. **Token expiry.** Each socket gets a timer set to its token's `exp`. Before it fires, the
   client gets a new access token over REST (the refresh cookie) and sends it with
   `auth:refresh`. The server checks that it belongs to the same user and session, then moves
   the deadline. Without that, the socket is disconnected when the token expires. Logging out, or
   a detected reuse of a refresh token, disconnects every socket of that session through the
   `session:<sid>` room.
3. **Rooms.** On connect the server looks up the user's memberships and joins their `conv:*`
   rooms. Clients cannot ask to join a room, so they only hear conversations they belong to.
4. **Every event is checked.** Handlers parse the payload, then call a service function that
   loads the caller's membership and role from the database and applies the rule (`can()` in
   `shared/src/groups.ts`). A conversation id the user is not in gets `not_found`, the same as an
   id that does not exist, so ids cannot be probed. Changing a conversation id in the browser
   gets a rejected ack and nothing is stored.
5. **Removal is instant.** After a remove, leave or delete commits, the server sends
   `group:removed` to that user and then calls `socketsLeave` on the room for all their sockets.
   From that moment they get nothing from the room. Their next send fails the membership check.

File downloads follow the same rule: `GET /api/conversations/:id/attachments/:fileId` needs the
Bearer token and membership, and a file not yet sent is visible only to its uploader.

## Known limitations and trade-offs

- **One server instance.** Presence, typing throttles and rate limits live in memory. Running
  more than one instance would need the Socket.io Redis adapter and a shared store.
- **Files in Postgres (bytea).** This keeps the deploy to one service plus one database. It is
  fine for a 5 MB limit and a demo, but object storage (S3 and signed URLs) is the move at scale.
  Uploads that are never sent are not cleaned up yet (a periodic delete of old unclaimed rows
  would fix it).
- **Reconnect sync** fills the gap after the newest cached message (up to 5 pages, then it
  reloads the newest page) and refreshes edits, deletes and reactions only on the newest page.
  Older pages catch up when the chat is opened again.
- **Unread counts** are not lowered when an unread message is deleted until the next sidebar
  refresh.
- **Blob URLs** for images are never revoked during a session.
- **Delivered** means that some tab of the recipient received the message, not that it was
  displayed.
- **Render free tier** sleeps when idle, so the first request after a pause can take up to a
  minute. The free Postgres also expires after 30 days.
- **No email verification or password reset**, left out to fit the deadline.
