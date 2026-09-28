import { useState, type FormEvent } from 'react';
import { loginBody, signupBody, type AuthResponse } from '@chat/shared';
import { login, signup } from './api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Logo } from './icons';

type Mode = 'login' | 'signup';
type Field = 'email' | 'password' | 'displayName';

const serverMessages: Record<string, string> = {
  email_taken: 'That email is already registered.',
  invalid_credentials: 'Email or password is wrong.',
  rate_limited: 'Too many attempts. Try again later.',
  invalid_input: 'Check the fields and try again.',
  network: 'Cannot reach the server. Check your connection.',
};

export function AuthPage({ onAuthed }: { onAuthed: (s: AuthResponse) => void }) {
  const [mode, setMode] = useState<Mode>('login');
  const [values, setValues] = useState<Record<Field, string>>({
    email: '',
    password: '',
    displayName: '',
  });
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState('');
  const [pending, setPending] = useState(false);

  const switchMode = (next: Mode) => {
    setMode(next);
    setErrors({});
    setFormError('');
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError('');
    // Same schema as the server, so field errors show here and the 400 body can stay generic.
    const parsed = (mode === 'signup' ? signupBody : loginBody).safeParse(values);
    if (!parsed.success) {
      const next: Partial<Record<Field, string>> = {};
      for (const issue of parsed.error.issues) next[issue.path[0] as Field] ??= issue.message;
      setErrors(next);
      return;
    }
    setErrors({});
    setPending(true);
    const result =
      mode === 'signup'
        ? await signup(signupBody.parse(values))
        : await login(loginBody.parse(values));
    setPending(false);
    if (result.ok) onAuthed(result.data);
    else setFormError(serverMessages[result.error] ?? 'Something went wrong. Try again.');
  };

  const field = (name: Field, label: string, type: string, autoComplete: string) => (
    <div className="flex flex-col gap-2">
      <Label htmlFor={name}>{label}</Label>
      <Input
        id={name}
        type={type}
        autoComplete={autoComplete}
        value={values[name]}
        onChange={(e) => setValues({ ...values, [name]: e.target.value })}
        aria-invalid={errors[name] ? true : undefined}
        aria-describedby={errors[name] ? `${name}-error` : undefined}
        className="h-10"
      />
      {errors[name] && (
        <p id={`${name}-error`} className="text-sm text-destructive">
          {errors[name]}
        </p>
      )}
    </div>
  );

  const isSignup = mode === 'signup';
  return (
    <main className="flex h-full flex-col items-center overflow-y-auto bg-[radial-gradient(60rem_40rem_at_50%_-10%,color-mix(in_oklab,var(--primary)_10%,transparent),transparent_70%)] px-4 py-8">
      <Card className="my-auto w-full max-w-sm py-7 shadow-xl shadow-primary/5 [--card-spacing:--spacing(7)]">
        <CardHeader className="justify-items-center text-center">
          <div className="mb-4 flex flex-col items-center gap-2.5">
            <Logo className="size-11 rounded-xl" />
            <span className="text-sm font-semibold tracking-tight text-muted-foreground">Chat</span>
          </div>
          <CardTitle className="text-xl font-semibold tracking-tight">
            <h1>{isSignup ? 'Create an account' : 'Log in'}</h1>
          </CardTitle>
          <CardDescription>
            {isSignup ? 'Start chatting in seconds.' : 'Welcome back. Pick up where you left off.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-5">
            {isSignup && field('displayName', 'Name', 'text', 'name')}
            {field('email', 'Email', 'email', 'email')}
            {field(
              'password',
              'Password',
              'password',
              isSignup ? 'new-password' : 'current-password',
            )}
            {formError && (
              <p
                role="alert"
                className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {formError}
              </p>
            )}
            <Button type="submit" disabled={pending} size="lg" className="h-10">
              {pending ? 'Please wait...' : isSignup ? 'Sign up' : 'Log in'}
            </Button>
            <p className="text-center text-sm text-muted-foreground">
              {isSignup ? 'Already have an account? ' : 'New here? '}
              <button
                type="button"
                onClick={() => switchMode(isSignup ? 'login' : 'signup')}
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                {isSignup ? 'Log in' : 'Sign up'}
              </button>
            </p>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
