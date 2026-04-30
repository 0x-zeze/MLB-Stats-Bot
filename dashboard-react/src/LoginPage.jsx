import { LockKeyhole } from 'lucide-react';
import { useState } from 'react';
import { Button } from './components/ui/button.jsx';
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card.jsx';
import { Field, Input } from './components/ui/form.jsx';

const DEV_PREFILL_TOKEN = import.meta.env.VITE_DASHBOARD_API_TOKEN || '';

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
    <main className="min-h-screen bg-canvas px-4 py-10">
      <div className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-md items-center">
        <Card className="w-full">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-md bg-blue-50 text-blue-700">
                <LockKeyhole size={20} />
              </div>
              <div>
                <CardTitle>MLB Dashboard</CardTitle>
                <p className="mt-1 text-sm text-slate-500">Sign in with your dashboard token.</p>
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
              {error ? <p className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p> : null}
              <Button className="w-full" type="submit">
                Sign in
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
