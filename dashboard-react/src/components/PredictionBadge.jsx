import { lower } from '../utils.js';
import { Badge } from './ui/badge.jsx';

export function toneFor(value) {
  const text = lower(value);
  if (['bet', 'fresh', 'confirmed', 'available', 'high', 'win', 'push'].some((token) => text.includes(token))) {
    return 'green';
  }
  if (['lean', 'medium', 'projected', 'partial', 'default', 'stable'].some((token) => text.includes(token))) {
    return 'yellow';
  }
  if (['no bet', 'stale', 'missing', 'low', 'loss', 'lose', 'lost'].some((token) => text.includes(token))) {
    return 'red';
  }
  if (['waiting', 'unavailable', 'sample', 'pending'].some((token) => text.includes(token))) {
    return 'gray';
  }
  return 'blue';
}

export default function PredictionBadge({ children, tone, className = '' }) {
  const resolved = tone || toneFor(children);
  const variant = {
    green: 'success',
    yellow: 'warning',
    red: 'danger',
    gray: 'neutral',
    blue: 'default',
  }[resolved];
  return <Badge variant={variant} className={className}>{children}</Badge>;
}
