import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createGroupBody,
  type ConversationResponse,
  type UserSummary,
  type UsersResponse,
} from '@chat/shared';
import { Search, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiFetch } from '../api';
import { describeError, putConversation } from './cache';
import { Avatar } from './Sidebar';

/** Debounced user search. Picking a result hands it to the parent; `exclude` hides people. */
export function PeoplePicker({
  id,
  exclude,
  onPick,
}: {
  id: string;
  exclude: ReadonlySet<string>;
  onPick: (u: UserSummary) => void;
}) {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);
  const searching = text.trim().length >= 2;
  const users = useQuery({
    queryKey: ['users', q],
    queryFn: () =>
      apiFetch<UsersResponse>(`/api/users?q=${encodeURIComponent(q)}`).then((r) => r.data.users),
    enabled: searching && q.length >= 2,
  });
  const shown = users.data?.filter((u) => !exclude.has(u.id)) ?? [];

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>Add people</Label>
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          id={id}
          type="search"
          placeholder="Search by name or email"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="h-9 pl-8"
        />
      </div>
      {searching &&
        (users.isError ? (
          <p className="text-sm text-destructive">{describeError(users.error)}</p>
        ) : users.isPending || q !== text.trim() ? (
          <p className="text-sm text-muted-foreground">Searching...</p>
        ) : shown.length === 0 ? (
          <p className="text-sm text-muted-foreground">No one else matches that.</p>
        ) : (
          <ul className="max-h-48 overflow-y-auto rounded-lg border p-1">
            {shown.map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  onClick={() => onPick(u)}
                  className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  <Avatar name={u.displayName} url={null} size="sm" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium">{u.displayName}</span>
                    <span className="truncate text-xs text-muted-foreground">{u.email}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

export function NewGroupDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState('');
  const [picked, setPicked] = useState<UserSummary[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = createGroupBody.safeParse({
      name,
      avatarUrl: avatar.trim() || undefined,
      memberIds: picked.map((p) => p.id),
    });
    if (!body.success) {
      setError(
        name.trim() ? 'The avatar must be an https:// image URL.' : 'Give the group a name.',
      );
      return;
    }
    setError('');
    setBusy(true);
    try {
      const { data } = await apiFetch<ConversationResponse>('/api/conversations/groups', {
        method: 'POST',
        body: body.data,
      });
      putConversation(qc, data.conversation);
      onCreated(data.conversation.id);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[85dvh] flex-col gap-0 p-0 sm:max-w-md">
        <form onSubmit={(e) => void submit(e)} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader className="gap-1 px-5 pt-5 pb-4">
            <DialogTitle>New group</DialogTitle>
            <DialogDescription>Name it, then add the people you want in it.</DialogDescription>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5">
            <div className="flex flex-col gap-2">
              <Label htmlFor="group-name">Name</Label>
              <Input
                id="group-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
                required
                className="h-9"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="group-avatar">
                Avatar URL <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="group-avatar"
                type="url"
                placeholder="https://..."
                value={avatar}
                onChange={(e) => setAvatar(e.target.value)}
                maxLength={2048}
                className="h-9"
              />
            </div>
            <PeoplePicker
              id="group-people"
              exclude={new Set(picked.map((p) => p.id))}
              onPick={(u) => setPicked((p) => (p.length >= 99 ? p : [...p, u]))}
            />
            {picked.length > 0 && (
              <ul className="flex flex-wrap gap-1.5" aria-label="People in the new group">
                {picked.map((u) => (
                  <li key={u.id}>
                    <Badge variant="secondary" className="h-7 gap-1 pr-1 pl-2.5 text-sm">
                      {u.displayName}
                      <button
                        type="button"
                        onClick={() => setPicked((p) => p.filter((x) => x.id !== u.id))}
                        aria-label={`Remove ${u.displayName}`}
                        className="flex size-5 items-center justify-center rounded-full hover:bg-foreground/10 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                      >
                        <X className="size-3.5" />
                      </button>
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <DialogFooter className="mx-0 mb-0 items-center">
            {error && (
              <p role="alert" className="text-sm text-destructive sm:mr-auto">
                {error}
              </p>
            )}
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
