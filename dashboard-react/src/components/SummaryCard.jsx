import { ArrowUpRight } from 'lucide-react';
import { Card, CardContent } from './ui/card.jsx';

export default function SummaryCard({ label, value, helper, icon: Icon = ArrowUpRight }) {
  return (
    <Card className="border-slate-200 shadow-none">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-slate-500">{label}</p>
            <p className="mt-2 text-2xl font-bold leading-none text-ink">{value}</p>
            {helper ? <p className="mt-2 truncate text-xs text-slate-500">{helper}</p> : null}
          </div>
          <div className="rounded-md bg-slate-50 p-2 text-slate-400">
            <Icon size={16} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
