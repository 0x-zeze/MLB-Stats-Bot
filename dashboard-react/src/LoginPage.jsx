import { LockKeyhole } from 'lucide-react';
import { useState } from 'react';
import { Button } from './components/ui/button.jsx';
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card.jsx';
import { Field, Input } from './components/ui/form.jsx';

const DEV_PREFILL_TOKEN = import.meta.env.DEV ? import.meta.env.VITE_DASHBOARD_API_TOKEN || '' : '';

export default function LoginPage({ onLogin }) {
  const [token, setToken] = useState(DEV_PREFILL_TOKEN);
  const [error, setError] = useState('');

  function submit(event) {
    event.preventDefault();
    const nextToken = token.trim();
    if (!nextToken) {
      setError('Enter the dashboard token.');
      return;
    }

    setError('');
    onLogin(nextToken);
  }

  return (
    <main className="min-h-screen bg-cream px-4 py-10 text-ink">
      <div className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-md items-center">
        <Card className="w-full">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-md border-3 border-ink bg-accent-blue text-ink shadow-neo-sm">
                <LockKeyhole size={22} />
              </div>
              <div>
                <CardTitle>MLB Dashboard</CardTitle>
                <p className="mt-1 text-sm font-semibold text-ink/75">Sign in with your dashboard token.</p>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={submit}>
              <Field label="Dashboard token">
                <Input
                  autoComplete="current-password"
                  autoFocus
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                />
              </Field>
              {error ? <p className="rounded-md border-2 border-ink bg-accent-red px-3 py-2 text-sm font-black text-ink shadow-neo-sm">{error}</p> : null}
              <Button className="w-full" type="submit" variant="primary">
                Sign in
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
