import PredictionBadge from './PredictionBadge.jsx';

export default function DataQualityBadge({ score }) {
  const parsed = Number(score) || 0;
  const tone = parsed >= 85 ? 'green' : parsed >= 70 ? 'yellow' : parsed >= 60 ? 'yellow' : 'red';
  return <PredictionBadge tone={tone}>Quality {parsed}/100</PredictionBadge>;
}
