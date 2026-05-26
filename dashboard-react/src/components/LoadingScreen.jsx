import { Activity } from 'lucide-react';
import { useEffect, useState } from 'react';

export default function LoadingScreen() {
  const [showRetry, setShowRetry] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setShowRetry(true), 5000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="min-h-screen bg-navy-950 flex items-center justify-center">
      <div className="text-center animate-fade-in">
        <div className="inline-flex items-center justify-center h-16 w-16 rounded-2xl bg-accent-red/20 border border-accent-red/30 mb-6">
          <Activity className="h-8 w-8 text-accent-red animate-pulse-slow" />
        </div>
        <h1 className="text-xl font-bold text-white mb-2">MLB Stats Bot</h1>
        <p className="text-sm text-slate-400 mb-6">AI-powered MLB slate analysis, predictions, alerts, and post-game learning.</p>
        <div className="flex items-center justify-center gap-2">
          <div className="h-1.5 w-1.5 rounded-full bg-accent-blue animate-pulse" style={{ animationDelay: '0ms' }} />
          <div className="h-1.5 w-1.5 rounded-full bg-accent-blue animate-pulse" style={{ animationDelay: '200ms' }} />
          <div className="h-1.5 w-1.5 rounded-full bg-accent-blue animate-pulse" style={{ animationDelay: '400ms' }} />
        </div>
        <p className="text-xs text-slate-500 mt-4">Loading today's slate...</p>
        {showRetry && (
          <p className="text-xs text-slate-500 mt-3">
            Taking longer than expected. Make sure the API server is running.
          </p>
        )}
      </div>
    </div>
  );
}
