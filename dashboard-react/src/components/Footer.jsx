import { Github, BookOpen, Send, LayoutDashboard, Shield, Mail } from 'lucide-react';

export function Footer() {
  return (
    <footer className="border-t border-white/[0.06] mt-12">
      <div className="mx-auto max-w-[1600px] px-4 py-8">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-8">
          <div>
            <h4 className="text-xs font-semibold text-white uppercase tracking-wider mb-3">Product</h4>
            <ul className="space-y-2">
              <li><a href="#" className="text-xs text-slate-400 hover:text-white transition-colors">Dashboard</a></li>
              <li><a href="#" className="text-xs text-slate-400 hover:text-white transition-colors">Documentation</a></li>
              <li><a href="#" className="text-xs text-slate-400 hover:text-white transition-colors">Dashboard Guide</a></li>
            </ul>
          </div>
          <div>
            <h4 className="text-xs font-semibold text-white uppercase tracking-wider mb-3">Integration</h4>
            <ul className="space-y-2">
              <li><a href="#" className="text-xs text-slate-400 hover:text-white transition-colors flex items-center gap-1.5"><Send className="h-3 w-3" />Telegram Setup</a></li>
              <li><a href="#" className="text-xs text-slate-400 hover:text-white transition-colors flex items-center gap-1.5"><Github className="h-3 w-3" />GitHub</a></li>
            </ul>
          </div>
          <div>
            <h4 className="text-xs font-semibold text-white uppercase tracking-wider mb-3">Legal</h4>
            <ul className="space-y-2">
              <li><a href="#" className="text-xs text-slate-400 hover:text-white transition-colors">Disclaimer</a></li>
              <li><a href="#" className="text-xs text-slate-400 hover:text-white transition-colors">Privacy</a></li>
            </ul>
          </div>
          <div>
            <h4 className="text-xs font-semibold text-white uppercase tracking-wider mb-3">Contact</h4>
            <ul className="space-y-2">
              <li><a href="#" className="text-xs text-slate-400 hover:text-white transition-colors flex items-center gap-1.5"><Mail className="h-3 w-3" />Contact</a></li>
            </ul>
          </div>
        </div>

        <div className="stitch-line mb-6" />

        <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded bg-accent-red/20 border border-accent-red/30 flex items-center justify-center">
              <LayoutDashboard className="h-3 w-3 text-accent-red" />
            </div>
            <span className="text-xs font-semibold text-white">MLB Stats Bot</span>
          </div>
          <p className="text-[11px] text-slate-500 text-center max-w-lg">
            MLB Stats Bot is an analytics and educational tool. Probabilities are model estimates and do not guarantee outcomes.
          </p>
          <span className="text-[11px] text-slate-500">v2.0</span>
        </div>
      </div>
    </footer>
  );
}
