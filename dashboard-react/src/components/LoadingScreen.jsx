import { Activity } from 'lucide-react';
import { useEffect, useState } from 'react';

export default function LoadingScreen() {
  const [showRetry, setShowRetry] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setShowRetry(true), 20000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-cream">
      <div className="animate-fade-in rounded-xl border-4 border-ink bg-paper p-8 text-center shadow-neo-lg">
        <div className="mb-6 inline-flex h-16 w-16 items-center justify-center rounded-2xl border-3 border-ink bg-accent-red shadow-neo">
          <Activity className="h-8 w-8 animate-pulse-slow text-ink" />
        </div>
        <h1 className="mb-2 text-xl font-black uppercase text-ink">MLB Stats Bot</h1>
        <p className="mb-6 text-sm font-semibold text-ink/70">AI-powered MLB slate analysis, predictions, alerts, and post-game learning.</p>
        <div className="flex items-center justify-center gap-2">
          <div className="h-1.5 w-1.5 rounded-full bg-accent-blue animate-pulse" style={{ animationDelay: '0ms' }} />
          <div className="h-1.5 w-1.5 rounded-full bg-accent-blue animate-pulse" style={{ animationDelay: '200ms' }} />
          <div className="h-1.5 w-1.5 rounded-full bg-accent-blue animate-pulse" style={{ animationDelay: '400ms' }} />
        </div>
        <p className="mt-4 text-xs font-black uppercase text-ink/60">Loading today's slate...</p>
        {showRetry && (
          <p className="mt-3 text-xs font-semibold text-ink/60">
            Still loading the live slate. The first load runs the full prediction pipeline and can take ~15s; if it persists, check the API server.
          </p>
        )}
      </div>
    </div>
  );
}
