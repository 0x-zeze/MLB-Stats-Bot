import { isFiniteNum, signed } from '../utils.js';

export default function EdgeIndicator({ value, suffix = '%' }) {
  const valid = isFiniteNum(value);
  const parsed = valid ? Number(value) : NaN;
  const color = !valid
    ? 'text-slate-500'
    : parsed >= 4
      ? 'text-accent-green'
      : parsed >= 2
        ? 'text-amber-400'
        : parsed <= -1
          ? 'text-accent-red'
          : 'text-slate-400';
  return <span className={`font-semibold ${color}`}>{valid ? signed(parsed, suffix) : '-'}</span>;
}
