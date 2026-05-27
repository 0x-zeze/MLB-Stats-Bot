import { signed } from '../utils.js';

export default function EdgeIndicator({ value, suffix = '%' }) {
  const parsed = Number(value);
  const color = !Number.isFinite(parsed)
    ? 'text-slate-500'
    : parsed >= 4
      ? 'text-accent-green'
      : parsed >= 2
        ? 'text-amber-400'
        : parsed <= -1
          ? 'text-accent-red'
          : 'text-slate-400';
  return <span className={`font-semibold ${color}`}>{Number.isFinite(parsed) ? signed(parsed, suffix) : '-'}</span>;
}
