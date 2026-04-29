import { lower } from '../utils.js';

const toneMap = {
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  yellow: 'bg-amber-50 text-amber-700 ring-amber-200',
  red: 'bg-rose-50 text-rose-700 ring-rose-200',
  gray: 'bg-slate-100 text-slate-600 ring-slate-200',
  blue: 'bg-blue-50 text-blue-700 ring-blue-200',
};

export function toneFor(value) {
  const text = lower(value);
  if (['bet', 'fresh', 'confirmed', 'available', 'high'].some((token) => text.includes(token))) {
    return 'green';
  }
  if (['lean', 'medium', 'projected', 'partial', 'default', 'stable'].some((token) => text.includes(token))) {
    return 'yellow';
  }
  if (['no bet', 'stale', 'missing', 'low'].some((token) => text.includes(token))) {
    return 'red';
  }
  if (['waiting', 'unavailable', 'sample'].some((token) => text.includes(token))) {
    return 'gray';
  }
  return 'blue';
}

export default function PredictionBadge({ children, tone, className = '' }) {
  const resolved = tone || toneFor(children);
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${toneMap[resolved]} ${className}`}>
      {children}
    </span>
  );
}
