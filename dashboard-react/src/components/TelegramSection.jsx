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
            <p className="mt-1 text-xs font-semibold text-ink/70">Bot status, alert configuration, and command reference.</p>
          </div>
          <Badge variant="success">Connected</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid lg:grid-cols-2 gap-6">
          <div className="space-y-4">
            <div>
              <h4 className="text-xs font-semibold text-ink/60 uppercase tracking-wider mb-3">Bot Status</h4>
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg border-2 border-ink bg-paper p-3 shadow-neo-sm">
                  <div className="flex items-center gap-2 mb-1">
                    <Bell className="h-3 w-3 text-accent-green" />
                    <span className="text-[11px] text-ink/60">Auto Alerts</span>
                  </div>
                  <p className="text-sm font-semibold text-accent-green">Enabled</p>
                </div>
                <div className="rounded-lg border-2 border-ink bg-paper p-3 shadow-neo-sm">
                  <div className="flex items-center gap-2 mb-1">
                    <Clock className="h-3 w-3 text-accent-blue" />
                    <span className="text-[11px] text-ink/60">Alert Time</span>
                  </div>
                  <p className="text-sm font-semibold text-ink">10:00 AM</p>
                </div>
                <div className="rounded-lg border-2 border-ink bg-paper p-3 shadow-neo-sm">
                  <div className="flex items-center gap-2 mb-1">
                    <CheckCircle className="h-3 w-3 text-accent-green" />
                    <span className="text-[11px] text-ink/60">Post-game</span>
                  </div>
                  <p className="text-sm font-semibold text-accent-green">Active</p>
                </div>
                <div className="rounded-lg border-2 border-ink bg-paper p-3 shadow-neo-sm">
                  <div className="flex items-center gap-2 mb-1">
                    <Zap className="h-3 w-3 text-accent-blue" />
                    <span className="text-[11px] text-ink/60">Agent</span>
                  </div>
                  <p className="text-sm font-semibold text-accent-blue">Interactive</p>
                </div>
              </div>
            </div>

            <div>
              <h4 className="text-xs font-semibold text-ink/60 uppercase tracking-wider mb-3">Commands <span className="text-ink/50">(click to try)</span></h4>
              <div className="space-y-1">
                {COMMANDS.map((c) => (
                  <button
                    key={c.cmd}
                    onClick={() => handleCommandClick(c.cmd)}
                    className="flex w-full items-center justify-between rounded-md border-2 border-transparent px-2 py-1.5 text-left transition-colors hover:border-ink hover:bg-accent-yellow"
                  >
                    <code className="text-xs font-mono text-accent-blue">{c.cmd}</code>
                    <span className="text-[11px] text-ink/50">{c.desc}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div>
            <h4 className="text-xs font-semibold text-ink/60 uppercase tracking-wider mb-3">Chat Preview</h4>
            <div className="flex h-[500px] flex-col overflow-hidden rounded-xl border-3 border-ink bg-cream shadow-neo">
              <div className="flex flex-shrink-0 items-center gap-2 border-b-3 border-ink bg-accent-blue px-4 py-2.5">
                <div className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-ink bg-paper">
                  <MessageSquare className="h-3 w-3 text-ink" />
                </div>
                <span className="text-xs font-semibold text-ink">MLB Stats Bot</span>
                <Badge variant="success" className="ml-auto text-[9px]">Online</Badge>
              </div>
              <div className="flex-1 p-4 space-y-3 overflow-y-auto">
                {messages.map((msg, i) => (
                  <div key={i} className={`flex ${msg.from === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[85%] rounded-lg px-3 py-2 text-xs ${
                      msg.from === 'user'
                        ? 'border-2 border-ink bg-accent-blue text-ink shadow-neo-sm'
                        : 'border-2 border-ink bg-paper text-ink shadow-neo-sm'
                    }`}>
                      <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed">{msg.text}</pre>
                    </div>
                  </div>
                ))}
                <div ref={chatEndRef} />
              </div>
              <form onSubmit={handleSubmit} className="flex flex-shrink-0 items-center gap-2 border-t-3 border-ink bg-paper px-4 py-2.5">
                <input
                  ref={inputRef}
                  type="text"
                  className="flex-1 rounded-lg border-2 border-ink bg-white px-3 py-2 text-sm font-semibold text-ink placeholder-ink/50 shadow-neo-sm focus:outline-none focus:ring-2 focus:ring-accent-yellow"
                  placeholder="Type a command... (e.g. /today)"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  autoComplete="off"
                  spellCheck="false"
                />
                <button
                  type="submit"
                  className="rounded-lg border-2 border-ink bg-accent-blue px-4 py-2 text-sm font-black uppercase text-ink shadow-neo-sm transition-all hover:-translate-x-0.5 hover:-translate-y-0.5 hover:bg-accent-yellow hover:shadow-neo"
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
