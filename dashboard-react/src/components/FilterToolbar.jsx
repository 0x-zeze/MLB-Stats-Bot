import { Download, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { Button } from './ui/button.jsx';
import { Card, CardContent } from './ui/card.jsx';
import { Field, Input, Select } from './ui/form.jsx';
import SortDropdown from './SortDropdown.jsx';

export default function FilterToolbar({
  filters,
  activeFilter,
  onFilterChange,
  sort,
  sorts,
  onSortChange,
  source,
  onSourceChange,
  date,
  onDateChange,
  loading,
  onRefresh,
  exportHref,
}) {
  const [open, setOpen] = useState(false);
  const activeFilterLabel = filters.find(([value]) => value === activeFilter)?.[1] || 'All games';
  const activeSortLabel = sorts.find(([value]) => value === sort)?.[1] || 'Game time';
  return (
    <Card className="sticky top-[88px] z-10 border-slate-200 shadow-none">
      <CardContent className="p-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span>{activeFilterLabel}</span>
            <span className="text-slate-300">/</span>
            <span>{activeSortLabel}</span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            <Input className="col-span-2 sm:col-span-1" type="date" value={date} onChange={(event) => onDateChange(event.target.value)} />
            <Select value={source} onChange={(event) => onSourceChange(event.target.value)}>
              <option value="live">Live</option>
              <option value="sample">Sample</option>
              <option value="mock">Mock</option>
            </Select>
            <Button onClick={onRefresh} type="button">
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
              Refresh
            </Button>
            <Button variant="secondary" type="button" onClick={() => setOpen((value) => !value)}>
              <SlidersHorizontal size={16} />
              Filters
            </Button>
          </div>
        </div>
        {open ? (
          <div className="mt-3 grid gap-3 border-t border-slate-100 pt-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
            <Field label="Show">
              <Select value={activeFilter} onChange={(event) => onFilterChange(event.target.value)}>
                {filters.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </Select>
            </Field>
            <Field label="Sort">
              <SortDropdown value={sort} options={sorts} onChange={onSortChange} />
            </Field>
            <Button asChild variant="secondary">
              <a href={exportHref}>
                <Download size={16} />
                CSV
              </a>
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
