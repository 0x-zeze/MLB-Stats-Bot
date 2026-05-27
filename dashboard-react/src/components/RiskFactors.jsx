import { asArray } from '../utils.js';

export default function RiskFactors({ title = 'Risk Factors', items }) {
  const list = asArray(items);
  return (
    <section>
      <h4 className="mb-2 text-sm font-bold text-ink">{title}</h4>
      {list.length ? (
        <ul className="space-y-1 text-sm font-semibold text-ink/70">
          {list.map((item) => (
            <li key={item} className="flex gap-2">
              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-ink" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm font-semibold text-ink/50">No major risk note.</p>
      )}
    </section>
  );
}
