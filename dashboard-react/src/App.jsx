import { useEffect, useState } from 'react';
import { api } from './api.js';
import Layout from './components/Layout.jsx';
import HeroSection from './components/HeroSection.jsx';
import TodaySlate from './components/TodaySlate.jsx';
import PredictionDetail from './components/PredictionDetail.jsx';
import MoneylineSection from './components/MoneylineSection.jsx';
import TotalsSection from './components/TotalsSection.jsx';
import YrfiSection from './components/YrfiSection.jsx';
import TeamAnalytics from './components/TeamAnalytics.jsx';
import DataQualitySection from './components/DataQualitySection.jsx';
import AnalystAgent from './components/AnalystAgent.jsx';
import MemorySection from './components/MemorySection.jsx';
import BacktestSection from './components/BacktestSection.jsx';
import TelegramSection from './components/TelegramSection.jsx';
import SettingsSection from './components/SettingsSection.jsx';
import LoadingScreen from './components/LoadingScreen.jsx';
import LoginPage from './LoginPage.jsx';
import { useAuth } from './useAuth.js';

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

export default function App() {
  const auth = useAuth();
  const [activeTab, setActiveTab] = useState('dashboard');
  const [date, setDate] = useState(todayDate());
  const [selectedGame, setSelectedGame] = useState(null);
  const [todayData, setTodayData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [initialLoad, setInitialLoad] = useState(true);
  const [error, setError] = useState(null);
  const [authRequired, setAuthRequired] = useState(false);

  useEffect(() => {
    fetchToday();
  }, [date, auth.token]);

  function isAuthError(err) {
    return String(err?.message || '').toLowerCase().includes('dashboard api token');
  }

  async function fetchToday() {
    setLoading(true);
    setError(null);
    try {
      const data = await api.today({ date, source: 'live' });
      setTodayData(data);
      setAuthRequired(false);
    } catch (err) {
      if (isAuthError(err)) {
        auth.logout();
        setAuthRequired(true);
        setInitialLoad(false);
        setLoading(false);
        return;
      }
      try {
        const data = await api.today({ date, source: 'sample' });
        setTodayData(data);
      } catch {
        setTodayData({ games: [], summary: {} });
        setError('Could not connect to API. Showing empty state.');
      }
    } finally {
      setLoading(false);
      setInitialLoad(false);
    }
  }

  if (authRequired && !auth.isAuthenticated) {
    return (
      <LoginPage
        onLogin={(token) => {
          auth.login(token);
          setAuthRequired(false);
        }}
      />
    );
  }

  if (initialLoad) {
    return <LoadingScreen />;
  }

  const games = todayData?.games || [];
  const summary = todayData?.summary || {};

  return (
    <Layout
      activeTab={activeTab}
      onTabChange={setActiveTab}
      onRefresh={fetchToday}
      date={date}
      onDateChange={setDate}
    >
      {activeTab === 'dashboard' && (
        <div className="space-y-6 animate-fade-in">
          <HeroSection
            onRefresh={fetchToday}
            onTabChange={setActiveTab}
            summary={summary}
            loading={loading}
          />
          <TodaySlate
            games={games}
            loading={loading}
            error={error}
            onSelectGame={setSelectedGame}
          />
          {selectedGame && <PredictionDetail game={selectedGame} onClose={() => setSelectedGame(null)} />}
          <div className="grid lg:grid-cols-2 gap-6">
            <MoneylineSection games={games} />
            <TotalsSection games={games} />
          </div>
          <YrfiSection games={games} />
        </div>
      )}

      {activeTab === 'games' && (
        <div className="space-y-6 animate-fade-in">
          <h2 className="text-xl font-bold text-white">Today's Games</h2>
          <TodaySlate games={games} loading={loading} error={error} onSelectGame={setSelectedGame} />
          {selectedGame && <PredictionDetail game={selectedGame} onClose={() => setSelectedGame(null)} />}
          <TeamAnalytics game={selectedGame} />
        </div>
      )}

      {activeTab === 'predictions' && (
        <div className="space-y-6 animate-fade-in">
          <h2 className="text-xl font-bold text-white">Predictions</h2>
          <TodaySlate games={games} loading={loading} error={error} onSelectGame={setSelectedGame} />
          {selectedGame && <PredictionDetail game={selectedGame} onClose={() => setSelectedGame(null)} />}
          <AnalystAgent game={selectedGame} />
        </div>
      )}

      {activeTab === 'moneyline' && (
        <div className="space-y-6 animate-fade-in">
          <h2 className="text-xl font-bold text-white">Moneyline Value Engine</h2>
          <MoneylineSection games={games} />
        </div>
      )}

      {activeTab === 'totals' && (
        <div className="space-y-6 animate-fade-in">
          <h2 className="text-xl font-bold text-white">Totals Analysis</h2>
          <TotalsSection games={games} />
        </div>
      )}

      {activeTab === 'yrfi' && (
        <div className="space-y-6 animate-fade-in">
          <h2 className="text-xl font-bold text-white">YRFI / NRFI Analysis</h2>
          <YrfiSection games={games} />
        </div>
      )}

      {activeTab === 'backtest' && (
        <div className="space-y-6 animate-fade-in">
          <h2 className="text-xl font-bold text-white">Backtest</h2>
          <BacktestSection />
        </div>
      )}

      {activeTab === 'memory' && (
        <div className="space-y-6 animate-fade-in">
          <h2 className="text-xl font-bold text-white">Memory & Learning</h2>
          <MemorySection />
          <AnalystAgent game={selectedGame} />
        </div>
      )}

      {activeTab === 'telegram' && (
        <div className="space-y-6 animate-fade-in">
          <h2 className="text-xl font-bold text-white">Telegram Integration</h2>
          <TelegramSection />
        </div>
      )}

      {activeTab === 'settings' && (
        <div className="space-y-6 animate-fade-in">
          <h2 className="text-xl font-bold text-white">Settings</h2>
          <SettingsSection />
          <DataQualitySection />
        </div>
      )}
    </Layout>
  );
}
