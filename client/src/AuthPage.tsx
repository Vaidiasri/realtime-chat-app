import { useState, type FormEvent } from 'react';
import { loginBody, signupBody, type AuthResponse } from '@chat/shared';
import { login, signup } from './api';
import { Logo } from './icons';

const Brand = () => (
  <div className="flex items-center gap-3">
    <Logo />
    <span className="text-lg font-semibold tracking-tight text-slate-900">Chat</span>
  </div>
);

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
    <div className="flex flex-col gap-1">
      <label htmlFor={name} className="text-sm font-medium text-slate-700">
        {label}
      </label>
      <input
        id={name}
        type={type}
        autoComplete={autoComplete}
        value={values[name]}
        onChange={(e) => setValues({ ...values, [name]: e.target.value })}
        aria-invalid={errors[name] ? true : undefined}
        aria-describedby={errors[name] ? `${name}-error` : undefined}
        className="input"
      />
      {errors[name] && (
        <p id={`${name}-error`} className="text-sm text-red-700">
          {errors[name]}
        </p>
      )}
    </div>
  );

  const isSignup = mode === 'signup';
  return (
    <main className="flex h-full flex-col items-center justify-center overflow-y-auto px-4 py-8 text-slate-900">
      <Brand />
      <form
        onSubmit={(e) => void submit(e)}
        noValidate
        className="glass panel mt-6 flex w-full max-w-sm flex-col gap-4 rounded-2xl p-7"
      >
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {isSignup ? 'Create an account' : 'Log in'}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {isSignup ? 'Start chatting in seconds.' : 'Welcome back. Pick up where you left off.'}
          </p>
        </div>
        {isSignup && field('displayName', 'Name', 'text', 'name')}
        {field('email', 'Email', 'email', 'email')}
        {field('password', 'Password', 'password', isSignup ? 'new-password' : 'current-password')}
        {formError && (
          <p role="alert" className="text-sm text-red-700">
            {formError}
          </p>
        )}
        <button type="submit" disabled={pending} className="btn btn-primary py-2">
          {pending ? 'Please wait...' : isSignup ? 'Sign up' : 'Log in'}
        </button>
        <p className="text-center text-sm text-slate-500">
          {isSignup ? 'Already have an account? ' : 'New here? '}
          <button
            type="button"
            onClick={() => switchMode(isSignup ? 'login' : 'signup')}
            className="font-medium text-accent hover:underline"
          >
            {isSignup ? 'Log in' : 'Sign up'}
          </button>
        </p>
      </form>
    </main>
  );
}
