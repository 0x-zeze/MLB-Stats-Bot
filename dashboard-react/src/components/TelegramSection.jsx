import { useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.jsx';
import { Badge } from './ui/badge.jsx';
import { Button } from './ui/button.jsx';
import { Send, Bell, Clock, MessageSquare, Zap, CheckCircle } from 'lucide-react';

const COMMANDS = [
  { cmd: '/today', desc: 'Compact slate of all games today' },
  { cmd: '/deep', desc: 'Full stats for all games' },
  { cmd: '/game TEAM', desc: 'Single team lookup' },
  { cmd: '/ask QUESTION', desc: 'Interactive Analyst Agent query' },
  { cmd: '/autoupdate on', desc: 'Enable daily auto alerts' },
  { cmd: '/autoupdate off', desc: 'Disable daily auto alerts' },
  { cmd: '/autoupdate time HH:MM', desc: 'Set alert time' },
  { cmd: '/chatid', desc: 'Show your chat ID' },
];

const BOT_RESPONSES = {
  '/today': `⚾ MLB Slate — May 26, 2026

🟢 NYY @ BOS — 7:10 PM
   Pick: NYY | Conf: High | Edge: +4.2%
   Cole vs Bello | VALUE

🔵 LAD @ SF — 9:45 PM
   Pick: LAD | Conf: Medium | Edge: +2.3%
   Yamamoto vs Webb | LEAN ONLY

🔴 HOU @ TEX — 8:05 PM
   Pick: NO BET | Conf: Low
   Valdez vs Eovaldi | Edge < 2%

📊 3 VALUE | 4 LEAN | 4 NO BET | 15 games`,
  '/chatid': '🆔 Your Chat ID: 123456789',
  '/autoupdate status': '✅ Auto-update: ON\n⏰ Time: 10:00 AM ET\n📬 Post-game: ON',
};

export default function TelegramSection() {
  const [messages, setMessages] = useState([
    { from: 'bot', text: 'Welcome to MLB Stats Bot! Type a command or click one from the list.' },
  ]);
  const [input, setInput] = useState('');
  const chatEndRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function sendMessage(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return;

    const userMsg = { from: 'user', text: trimmed };
    const botResponse = BOT_RESPONSES[trimmed.toLowerCase()] ||
      BOT_RESPONSES[trimmed.split(' ')[0]?.toLowerCase()] ||
      `⚙️ Command received: ${trimmed}\n\n(Connect Telegram bot for live responses)`;

    setMessages((prev) => [...prev, userMsg, { from: 'bot', text: botResponse }]);
    setInput('');
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  function handleSubmit(e) {
    e.preventDefault();
    sendMessage(input);
  }

  function handleCommandClick(cmd) {
    sendMessage(cmd);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Send className="h-4 w-4 text-accent-blue" />
              Telegram Integration
            </CardTitle>
            <p className="text-xs text-slate-400 mt-1">Bot status, alert configuration, and command reference.</p>
          </div>
          <Badge variant="success">Connected</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid lg:grid-cols-2 gap-6">
          <div className="space-y-4">
            <div>
              <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Bot Status</h4>
              <div className="grid grid-cols-2 gap-2">
                <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                  <div className="flex items-center gap-2 mb-1">
                    <Bell className="h-3 w-3 text-accent-green" />
                    <span className="text-[11px] text-slate-400">Auto Alerts</span>
                  </div>
                  <p className="text-sm font-semibold text-accent-green">Enabled</p>
                </div>
                <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                  <div className="flex items-center gap-2 mb-1">
                    <Clock className="h-3 w-3 text-accent-blue" />
                    <span className="text-[11px] text-slate-400">Alert Time</span>
                  </div>
                  <p className="text-sm font-semibold text-white">10:00 AM</p>
                </div>
                <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                  <div className="flex items-center gap-2 mb-1">
                    <CheckCircle className="h-3 w-3 text-accent-green" />
                    <span className="text-[11px] text-slate-400">Post-game</span>
                  </div>
                  <p className="text-sm font-semibold text-accent-green">Active</p>
                </div>
                <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                  <div className="flex items-center gap-2 mb-1">
                    <Zap className="h-3 w-3 text-accent-blue" />
                    <span className="text-[11px] text-slate-400">Agent</span>
                  </div>
                  <p className="text-sm font-semibold text-accent-blue">Interactive</p>
                </div>
              </div>
            </div>

            <div>
              <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Commands <span className="text-slate-500">(click to try)</span></h4>
              <div className="space-y-1">
                {COMMANDS.map((c) => (
                  <button
                    key={c.cmd}
                    onClick={() => handleCommandClick(c.cmd)}
                    className="w-full flex items-center justify-between py-1.5 px-2 rounded hover:bg-white/[0.04] transition-colors text-left"
                  >
                    <code className="text-xs font-mono text-accent-blue">{c.cmd}</code>
                    <span className="text-[11px] text-slate-500">{c.desc}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div>
            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Chat Preview</h4>
            <div className="rounded-xl bg-navy-900 border border-white/[0.06] overflow-hidden flex flex-col h-[500px]">
              <div className="px-4 py-2.5 border-b border-white/[0.06] flex items-center gap-2 flex-shrink-0">
                <div className="h-6 w-6 rounded-full bg-accent-blue/20 flex items-center justify-center">
                  <MessageSquare className="h-3 w-3 text-accent-blue" />
                </div>
                <span className="text-xs font-semibold text-white">MLB Stats Bot</span>
                <Badge variant="success" className="ml-auto text-[9px]">Online</Badge>
              </div>
              <div className="flex-1 p-4 space-y-3 overflow-y-auto">
                {messages.map((msg, i) => (
                  <div key={i} className={`flex ${msg.from === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[85%] rounded-lg px-3 py-2 text-xs ${
                      msg.from === 'user'
                        ? 'bg-accent-blue/20 text-accent-blue border border-accent-blue/20'
                        : 'bg-white/[0.04] text-slate-300 border border-white/[0.06]'
                    }`}>
                      <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed">{msg.text}</pre>
                    </div>
                  </div>
                ))}
                <div ref={chatEndRef} />
              </div>
              <form onSubmit={handleSubmit} className="px-4 py-2.5 border-t border-white/[0.06] flex items-center gap-2 flex-shrink-0">
                <input
                  ref={inputRef}
                  type="text"
                  className="flex-1 px-3 py-2 text-sm rounded-lg bg-navy-800 border border-white/10 text-white placeholder-slate-500 focus:outline-none focus:border-accent-blue focus:ring-1 focus:ring-accent-blue/30"
                  placeholder="Type a command... (e.g. /today)"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  autoComplete="off"
                  spellCheck="false"
                />
                <button
                  type="submit"
                  className="px-4 py-2 text-sm font-semibold rounded-lg bg-accent-blue text-navy-900 hover:bg-accent-blue/90 transition-colors"
                >
                  Send
                </button>
              </form>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
