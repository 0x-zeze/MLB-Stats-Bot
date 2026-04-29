const numericFields = [
  ['minimum_moneyline_edge', 'Minimum moneyline edge'],
  ['minimum_total_edge', 'Minimum total edge'],
  ['minimum_projected_total_difference', 'Minimum projected total difference'],
  ['minimum_data_quality_score', 'Minimum data quality score'],
  ['odds_stale_minutes', 'Odds stale threshold minutes'],
  ['weather_stale_minutes', 'Weather stale threshold minutes'],
  ['auto_refresh_minutes', 'Auto-refresh interval minutes'],
  ['low_confidence_threshold', 'Low confidence threshold'],
  ['medium_confidence_threshold', 'Medium confidence threshold'],
  ['high_confidence_threshold', 'High confidence threshold'],
];

const toggles = [
  ['enable_weather_adjustment', 'Weather adjustment'],
  ['enable_umpire_adjustment', 'Umpire adjustment'],
  ['enable_market_movement_adjustment', 'Market movement adjustment'],
];

export default function SettingsPanel({ settings, onChange, onSave, saving }) {
  return (
    <section className="rounded-lg border border-line bg-white p-5 shadow-soft">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-ink">Threshold Settings</h2>
          <p className="text-sm text-slate-500">These values control dashboard decision and stale-data warnings.</p>
        </div>
        <button className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700" onClick={onSave} type="button">
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {numericFields.map(([key, label]) => (
          <label key={key} className="grid gap-1 text-sm font-semibold text-ink">
            {label}
            <input
              className="rounded-md border border-line px-3 py-2 font-normal"
              type="number"
              step="0.01"
              value={settings?.[key] ?? ''}
              onChange={(event) => onChange({ ...settings, [key]: Number(event.target.value) })}
            />
          </label>
        ))}
      </div>
      <div className="mt-5 grid gap-3 md:grid-cols-3">
        {toggles.map(([key, label]) => (
          <label key={key} className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2 text-sm font-semibold">
            {label}
            <input
              type="checkbox"
              checked={Boolean(settings?.[key])}
              onChange={(event) => onChange({ ...settings, [key]: event.target.checked })}
            />
          </label>
        ))}
      </div>
    </section>
  );
}
