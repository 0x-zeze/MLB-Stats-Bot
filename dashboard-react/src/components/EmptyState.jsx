import { CircleOff } from 'lucide-react';
import { Card, CardContent } from './ui/card.jsx';

export default function EmptyState({ title = 'No data', message = 'Nothing to show yet.' }) {
  return (
    <Card>
      <CardContent className="grid min-h-56 place-items-center text-center">
        <div>
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full border-2 border-ink bg-accent-yellow text-ink shadow-neo-sm">
            <CircleOff size={20} />
          </div>
          <h3 className="text-base font-black uppercase text-ink">{title}</h3>
          <p className="mt-1 max-w-md text-sm font-semibold text-ink/50">{message}</p>
        </div>
      </CardContent>
    </Card>
  );
}
