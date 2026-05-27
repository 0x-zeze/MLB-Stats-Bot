import { ArrowUpRight } from 'lucide-react';
import { Card, CardContent } from './ui/card.jsx';

export default function SummaryCard({ label, value, helper, icon: Icon = ArrowUpRight }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-black uppercase text-ink/50">{label}</p>
            <p className="mt-2 text-2xl font-black leading-none text-ink">{value}</p>
            {helper ? <p className="mt-2 truncate text-xs font-semibold text-ink/50">{helper}</p> : null}
          </div>
          <div className="rounded-md border-2 border-ink bg-accent-blue p-2 text-ink shadow-neo-sm">
            <Icon size={16} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
