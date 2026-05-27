import { Github, Send, LayoutDashboard, Mail } from 'lucide-react';

export function Footer() {
  return (
    <footer className="mt-12 border-t-4 border-ink bg-paper">
      <div className="mx-auto max-w-[1600px] px-4 py-8">
        <div className="mb-8 grid grid-cols-2 gap-6 md:grid-cols-4">
          <div>
            <h4 className="mb-3 text-xs font-black uppercase tracking-tight text-ink">Product</h4>
            <ul className="space-y-2">
              <li><a href="#" className="text-xs font-semibold text-ink/75 underline decoration-2 underline-offset-4 hover:text-ink">Dashboard</a></li>
              <li><a href="#" className="text-xs font-semibold text-ink/75 underline decoration-2 underline-offset-4 hover:text-ink">Documentation</a></li>
              <li><a href="#" className="text-xs font-semibold text-ink/75 underline decoration-2 underline-offset-4 hover:text-ink">Dashboard Guide</a></li>
            </ul>
          </div>
          <div>
            <h4 className="mb-3 text-xs font-black uppercase tracking-tight text-ink">Integration</h4>
            <ul className="space-y-2">
              <li><a href="#" className="flex items-center gap-1.5 text-xs font-semibold text-ink/75 underline decoration-2 underline-offset-4 hover:text-ink"><Send className="h-3 w-3" />Telegram Setup</a></li>
              <li><a href="#" className="flex items-center gap-1.5 text-xs font-semibold text-ink/75 underline decoration-2 underline-offset-4 hover:text-ink"><Github className="h-3 w-3" />GitHub</a></li>
            </ul>
          </div>
          <div>
            <h4 className="mb-3 text-xs font-black uppercase tracking-tight text-ink">Legal</h4>
            <ul className="space-y-2">
              <li><a href="#" className="text-xs font-semibold text-ink/75 underline decoration-2 underline-offset-4 hover:text-ink">Disclaimer</a></li>
              <li><a href="#" className="text-xs font-semibold text-ink/75 underline decoration-2 underline-offset-4 hover:text-ink">Privacy</a></li>
            </ul>
          </div>
          <div>
            <h4 className="mb-3 text-xs font-black uppercase tracking-tight text-ink">Contact</h4>
            <ul className="space-y-2">
              <li><a href="#" className="flex items-center gap-1.5 text-xs font-semibold text-ink/75 underline decoration-2 underline-offset-4 hover:text-ink"><Mail className="h-3 w-3" />Contact</a></li>
            </ul>
          </div>
        </div>

        <div className="stitch-line mb-6" />

        <div className="flex flex-col items-center justify-between gap-3 sm:flex-row">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md border-2 border-ink bg-accent-red shadow-neo-sm">
              <LayoutDashboard className="h-3.5 w-3.5 text-ink" />
            </div>
            <span className="text-xs font-black uppercase tracking-tight text-ink">MLB Stats Bot</span>
          </div>
          <p className="max-w-lg text-center text-[11px] font-semibold text-ink/70">
            MLB Stats Bot is an analytics and educational tool. Probabilities are model estimates and do not guarantee outcomes.
          </p>
          <span className="rounded-md border-2 border-ink bg-accent-yellow px-2 py-1 text-[11px] font-black text-ink shadow-neo-sm">v2.0</span>
        </div>
      </div>
    </footer>
  );
}
