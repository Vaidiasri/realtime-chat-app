import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AuthResponse } from '@chat/shared';
import { refreshSession } from './api';
import { AuthPage } from './AuthPage';
import { ChatApp } from './chat/ChatApp';
import { Logo } from './icons';

// ponytail: no router; a reload returns to the sidebar with nothing open.
export function App() {
  // undefined while the boot refresh runs, null when signed out.
  const [session, setSession] = useState<AuthResponse | null | undefined>(undefined);
  const qc = useQueryClient();
  // Stable, so the socket effect does not reconnect on every App render. Clearing the cache keeps
  // one user's chats from showing to the next user in this tab.
  const signedOut = useCallback(() => {
    qc.clear();
    setSession(null);
  }, [qc]);

  useEffect(() => {
    void refreshSession().then(setSession);
  }, []);

  if (session === undefined) {
    return (
      <main className="flex h-full flex-col items-center justify-center gap-4 text-sm text-muted-foreground">
        <span className="animate-pulse">
          <Logo />
        </span>
        Loading...
      </main>
    );
  }
  if (!session) return <AuthPage onAuthed={setSession} />;
  return <ChatApp me={session.user} onSignedOut={signedOut} />;
}
