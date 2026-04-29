import { signed } from '../utils.js';

export default function EdgeIndicator({ value, suffix = '%' }) {
  const parsed = Number(value);
  const color = !Number.isFinite(parsed)
    ? 'text-slate-500'
    : parsed >= 4
      ? 'text-emerald-700'
      : parsed >= 2
        ? 'text-amber-700'
        : parsed <= -1
          ? 'text-rose-700'
          : 'text-slate-600';
  return <span className={`font-semibold ${color}`}>{Number.isFinite(parsed) ? signed(parsed, suffix) : '-'}</span>;
}
