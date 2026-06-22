import { Badge } from './ui/badge.jsx';
import { lower } from '../utils.js';

// Maps the bot's confidence band (tinggi/sedang/rendah) — and the older
// high/medium/low strings — to a tone. The band is derived from the calibrated
// win probability against the 58% conviction floor, so it mirrors what the
// Telegram bot shows the user.
const BAND_TONE = {
  tinggi: 'success',
  high: 'success',
  sedang: 'default',
  medium: 'default',
  rendah: 'warning',
  low: 'warning',
};

const BAND_LABEL = {
  tinggi: 'Tinggi',
  high: 'Tinggi',
  sedang: 'Sedang',
  medium: 'Sedang',
  rendah: 'Rendah',
  low: 'Rendah',
};

export default function ConfidenceBadge({ value }) {
  const key = lower(value);
  const tone = BAND_TONE[key] || 'neutral';
  const label = BAND_LABEL[key] || (value ? value : 'Rendah');
  return <Badge variant={tone}>Confidence: {label}</Badge>;
}
