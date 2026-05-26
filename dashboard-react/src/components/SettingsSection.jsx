import { useState, useEffect, useRef } from 'react';
import { api } from '../api.js';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.jsx';
import { Button } from './ui/button.jsx';
import { Settings, Globe, Brain, Bell, Database, Shield, Eye, Save, Check } from 'lucide-react';

const INITIAL_SETTINGS = {
  timezone: 'America/New_York',
  alertDetail: 'compact',
  agentEnabled: true,
  apiProvider: 'OpenRouter',
  modelName: 'anthropic/claude-sonnet-4-6',
  autoAlerts: true,
  postGameAlerts: true,
  lineMovementAlerts: true,
  oddsProvider: 'The Odds API',
  dashboardToken: '••••••••',
};

function Toggle({ enabled, onChange }) {
  return (
    <button
      onClick={() => onChange(!enabled)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
        enabled ? 'bg-accent-green' : 'bg-slate-600'
      }`}
    >
      <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
        enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
      }`} />
    </button>
  );
}

export default function SettingsSection() {
  const [settings, setSettings] = useState(INITIAL_SETTINGS);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const savedTimerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    api.settings()
      .then((data) => {
        if (!cancelled) {
          setSettings((prev) => ({ ...prev, ...data }));
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || 'Failed to load settings');
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  function update(key, value) {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }

  async function handleSave() {
    setError(null);
    try {
      await api.saveSettings(settings);
      setSaved(true);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err.message || 'Failed to save settings');
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Settings className="h-4 w-4 text-slate-400" />
              Settings
            </CardTitle>
            <p className="text-xs text-slate-400 mt-1">Configuration and integration status.</p>
          </div>
          <Button size="sm" variant={saved ? 'success' : 'secondary'} onClick={handleSave}>
            {saved ? <><Check className="h-3 w-3" /> Saved</> : <><Save className="h-3 w-3" /> Save Changes</>}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading && <p className="text-xs text-slate-400 py-4">Loading settings...</p>}
        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
            {error}
          </div>
        )}
        <div className="space-y-6">
          <div>
            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">General</h4>
            <div className="space-y-2">
              <div className="flex items-center justify-between p-3 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                <div className="flex items-center gap-3">
                  <div className="h-8 w-8 rounded-lg bg-white/[0.04] flex items-center justify-center">
                    <Globe className="h-4 w-4 text-slate-400" />
                  </div>
                  <span className="text-sm text-white">Timezone</span>
                </div>
                <select
                  value={settings.timezone}
                  onChange={(e) => update('timezone', e.target.value)}
                  className="glass-input px-3 py-1.5 text-xs"
                >
                  <option value="America/New_York">America/New_York</option>
                  <option value="America/Chicago">America/Chicago</option>
                  <option value="America/Denver">America/Denver</option>
                  <option value="America/Los_Angeles">America/Los_Angeles</option>
                  <option value="Asia/Jakarta">Asia/Jakarta</option>
                </select>
              </div>
              <div className="flex items-center justify-between p-3 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                <div className="flex items-center gap-3">
                  <div className="h-8 w-8 rounded-lg bg-white/[0.04] flex items-center justify-center">
                    <Eye className="h-4 w-4 text-slate-400" />
                  </div>
                  <span className="text-sm text-white">Alert Detail</span>
                </div>
                <select
                  value={settings.alertDetail}
                  onChange={(e) => update('alertDetail', e.target.value)}
                  className="glass-input px-3 py-1.5 text-xs"
                >
                  <option value="compact">Compact</option>
                  <option value="full">Full</option>
                </select>
              </div>
            </div>
          </div>

          <div>
            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Analyst Agent</h4>
            <div className="space-y-2">
              <div className="flex items-center justify-between p-3 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                <div className="flex items-center gap-3">
                  <div className="h-8 w-8 rounded-lg bg-white/[0.04] flex items-center justify-center">
                    <Brain className="h-4 w-4 text-slate-400" />
                  </div>
                  <span className="text-sm text-white">Agent Enabled</span>
                </div>
                <Toggle enabled={settings.agentEnabled} onChange={(v) => update('agentEnabled', v)} />
              </div>
              <div className="flex items-center justify-between p-3 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                <div className="flex items-center gap-3">
                  <div className="h-8 w-8 rounded-lg bg-white/[0.04] flex items-center justify-center">
                    <Database className="h-4 w-4 text-slate-400" />
                  </div>
                  <span className="text-sm text-white">API Provider</span>
                </div>
                <input
                  value={settings.apiProvider}
                  onChange={(e) => update('apiProvider', e.target.value)}
                  className="glass-input px-3 py-1.5 text-xs w-32 text-right"
                />
              </div>
              <div className="flex items-center justify-between p-3 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                <div className="flex items-center gap-3">
                  <div className="h-8 w-8 rounded-lg bg-white/[0.04] flex items-center justify-center">
                    <Brain className="h-4 w-4 text-slate-400" />
                  </div>
                  <span className="text-sm text-white">Model</span>
                </div>
                <input
                  value={settings.modelName}
                  onChange={(e) => update('modelName', e.target.value)}
                  className="glass-input px-3 py-1.5 text-xs w-48 text-right"
                />
              </div>
            </div>
          </div>

          <div>
            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Alerts</h4>
            <div className="space-y-2">
              <div className="flex items-center justify-between p-3 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                <div className="flex items-center gap-3">
                  <div className="h-8 w-8 rounded-lg bg-white/[0.04] flex items-center justify-center">
                    <Bell className="h-4 w-4 text-slate-400" />
                  </div>
                  <span className="text-sm text-white">Auto Alerts</span>
                </div>
                <Toggle enabled={settings.autoAlerts} onChange={(v) => update('autoAlerts', v)} />
              </div>
              <div className="flex items-center justify-between p-3 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                <div className="flex items-center gap-3">
                  <div className="h-8 w-8 rounded-lg bg-white/[0.04] flex items-center justify-center">
                    <Bell className="h-4 w-4 text-slate-400" />
                  </div>
                  <span className="text-sm text-white">Post-game Alerts</span>
                </div>
                <Toggle enabled={settings.postGameAlerts} onChange={(v) => update('postGameAlerts', v)} />
              </div>
              <div className="flex items-center justify-between p-3 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                <div className="flex items-center gap-3">
                  <div className="h-8 w-8 rounded-lg bg-white/[0.04] flex items-center justify-center">
                    <Bell className="h-4 w-4 text-slate-400" />
                  </div>
                  <span className="text-sm text-white">Line Movement Alerts</span>
                </div>
                <Toggle enabled={settings.lineMovementAlerts} onChange={(v) => update('lineMovementAlerts', v)} />
              </div>
            </div>
          </div>

          <div>
            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Data Sources</h4>
            <div className="space-y-2">
              <div className="flex items-center justify-between p-3 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                <div className="flex items-center gap-3">
                  <div className="h-8 w-8 rounded-lg bg-white/[0.04] flex items-center justify-center">
                    <Database className="h-4 w-4 text-slate-400" />
                  </div>
                  <span className="text-sm text-white">Odds Provider</span>
                </div>
                <input
                  value={settings.oddsProvider}
                  onChange={(e) => update('oddsProvider', e.target.value)}
                  className="glass-input px-3 py-1.5 text-xs w-32 text-right"
                />
              </div>
              <div className="flex items-center justify-between p-3 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                <div className="flex items-center gap-3">
                  <div className="h-8 w-8 rounded-lg bg-white/[0.04] flex items-center justify-center">
                    <Shield className="h-4 w-4 text-slate-400" />
                  </div>
                  <span className="text-sm text-white">Dashboard API Token</span>
                </div>
                <input
                  type="password"
                  value={settings.dashboardToken}
                  onChange={(e) => update('dashboardToken', e.target.value)}
                  className="glass-input px-3 py-1.5 text-xs w-32 text-right"
                />
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
