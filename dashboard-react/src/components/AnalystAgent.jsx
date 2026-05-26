import { Card, CardContent, CardHeader, CardTitle } from './ui/card.jsx';
import { Badge } from './ui/badge.jsx';
import { Brain, Terminal, CheckCircle, AlertTriangle } from 'lucide-react';

export default function AnalystAgent({ game }) {
  if (!game) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Brain className="h-4 w-4 text-accent-purple" />
                Analyst Agent
              </CardTitle>
              <p className="text-xs text-slate-400 mt-1">AI reasoning terminal — mlb-analyst-v1.1</p>
            </div>
            <Badge variant="success">Active</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-12 text-slate-500">
            <Terminal className="h-5 w-5 mr-2" />
            <span className="text-sm">Select a game to view agent analysis</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  const {
    away_team,
    home_team,
    moneyline,
    main_factors,
    risk_factors,
    betDecision,
    probable_pitchers,
    data_quality,
  } = game;

  const predictedWinner = moneyline?.predicted_winner || 'N/A';
  const winProb = moneyline?.home_probability != null
    ? (moneyline.predicted_winner === home_team
        ? moneyline.home_probability
        : moneyline.away_probability)
    : null;
  const edge = moneyline?.edge ?? betDecision?.edge ?? null;
  const confidence = moneyline?.confidence || 'N/A';
  const decision = betDecision?.decision || null;

  const getConfidenceBadgeVariant = (c) => {
    const lc = String(c).toLowerCase();
    if (lc === 'high') return 'success';
    if (lc === 'medium') return 'warning';
    return 'secondary';
  };

  const getDecisionColor = (d) => {
    if (!d) return 'text-slate-400';
    const uc = String(d).toUpperCase();
    if (uc.includes('VALUE')) return 'success';
    if (uc.includes('LEAN')) return 'warning';
    return 'danger';
  };

  const matchTitle = `${away_team} @ ${home_team}`;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Brain className="h-4 w-4 text-accent-purple" />
              Analyst Agent
            </CardTitle>
            <p className="text-xs text-slate-400 mt-1">AI reasoning terminal — mlb-analyst-v1.1</p>
          </div>
          <Badge variant="success">Active</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {/* Agent Reasoning Terminal */}
          <div className="p-4 rounded-lg bg-navy-900 border border-white/[0.06]">
            <div className="flex items-center gap-2 mb-3">
              <Terminal className="h-3.5 w-3.5 text-accent-blue" />
              <span className="text-xs font-semibold text-accent-blue">Agent Reasoning — {matchTitle}</span>
            </div>
            <div className="terminal-text space-y-2">
              {/* Input */}
              <p>
                <span className="highlight">[INPUT]</span>{' '}
                Baseline model: {home_team} {moneyline?.home_probability != null ? (moneyline.home_probability * 100).toFixed(1) + '%' : 'N/A'} | {away_team} {moneyline?.away_probability != null ? (moneyline.away_probability * 100).toFixed(1) + '%' : 'N/A'}
              </p>

              {/* Pitcher context */}
              {probable_pitchers && (
                <p>
                  <span className="highlight">[MATCHUP]</span>{' '}
                  {probable_pitchers.home || 'TBD'} vs {probable_pitchers.away || 'TBD'}
                </p>
              )}

              {/* Main Factors */}
              {main_factors && main_factors.length > 0 && (
                <>
                  <p><span className="highlight">[FACTORS]</span></p>
                  {main_factors.map((factor, i) => {
                    const text = typeof factor === 'string' ? factor : factor.description || factor.text || JSON.stringify(factor);
                    const isPositive = /\+/.test(text) || /favor|edge|advantage|strong|dominant/i.test(text);
                    const isNegative = /-/.test(text) && /\d/.test(text) && !isPositive;
                    return (
                      <p key={i}>
                        {'  • '}{text}
                        {isPositive && !isNegative && <span className="success ml-1">▲</span>}
                        {isNegative && <span className="danger ml-1">▼</span>}
                      </p>
                    );
                  })}
                </>
              )}

              {/* Risk Factors */}
              {risk_factors && risk_factors.length > 0 && (
                <>
                  <p><span className="highlight">[CAUTION]</span></p>
                  {risk_factors.map((risk, i) => (
                    <p key={i}>
                      <span className="warning">⚠</span>{' '}
                      {typeof risk === 'string' ? risk : risk.description || risk.text || JSON.stringify(risk)}
                    </p>
                  ))}
                </>
              )}

              {/* Decision */}
              {decision && (
                <p>
                  <span className="highlight">[DECISION]</span>{' '}
                  <span className={getDecisionColor(decision)}>{predictedWinner} — {decision}</span>
                </p>
              )}

              {/* Confidence & Edge */}
              <p>
                <span className="highlight">[CONFIDENCE]</span>{' '}
                {confidence}
                {edge != null ? ` (edge ${(edge * 100).toFixed(1)}%)` : ''}
              </p>

              {/* Data Quality warning */}
              {data_quality && data_quality.score != null && data_quality.score < 0.7 && (
                <p>
                  <span className="warning">[DATA QUALITY]</span>{' '}
                  <span className="warning">Low data quality score ({(data_quality.score * 100).toFixed(0)}%) — results may be less reliable</span>
                </p>
              )}
            </div>
          </div>

          {/* Bottom cards */}
          <div className="grid sm:grid-cols-2 gap-3">
            {/* Final Pick */}
            <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
              <div className="flex items-center gap-2 mb-2">
                <CheckCircle className="h-3.5 w-3.5 text-accent-green" />
                <span className="text-xs font-semibold text-white">Final Pick</span>
              </div>
              <p className="text-lg font-bold text-white">{predictedWinner}</p>
              <p className="text-xs text-slate-400 mt-1">
                Confidence: {confidence}
                {edge != null ? ` | Edge: +${(edge * 100).toFixed(1)}%` : ''}
                {winProb != null ? ` | Win Prob: ${(winProb * 100).toFixed(1)}%` : ''}
              </p>
              {decision && (
                <p className={`text-xs mt-1 font-semibold ${getDecisionColor(decision)}`}>
                  {decision}
                </p>
              )}
            </div>

            {/* Caution Notes */}
            <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="h-3.5 w-3.5 text-accent-yellow" />
                <span className="text-xs font-semibold text-white">Caution Notes</span>
              </div>
              {risk_factors && risk_factors.length > 0 ? (
                <ul className="text-xs text-slate-400 space-y-1">
                  {risk_factors.map((risk, i) => (
                    <li key={i}>• {typeof risk === 'string' ? risk : risk.description || risk.text || JSON.stringify(risk)}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-slate-500">No caution notes</p>
              )}
            </div>
          </div>

          {/* Educational note */}
          <div className="p-3 rounded-lg bg-accent-blue/5 border border-accent-blue/20">
            <p className="text-xs text-slate-400">
              <span className="text-accent-blue font-semibold">Educational note:</span>{' '}
              This analysis combines sabermetric data with contextual factors. The model probability represents the estimated likelihood based on available data. Market inefficiencies create value when model probability significantly exceeds implied odds probability.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
