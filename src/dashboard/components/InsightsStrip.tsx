import { qs, type Insight } from '../lib/api';
import { useDash } from '../lib/context';
import { useApi } from '../lib/useApi';

export function InsightsStrip() {
  const { q, reloadKey, addFilter, apiPrefix } = useDash();
  const { data } = useApi<Insight[]>(`${apiPrefix}/insights?${qs(q)}`, reloadKey);
  if (!data?.length) return null;

  return (
    <div className="mt-5">
      <div className="mb-2 text-sm font-medium text-stone-500">Insights</div>
      <div className="flex gap-3 overflow-x-auto pb-1">
        {data.map((card) => {
          const clickable = !!card.filter;
          const tone =
            card.sentiment === 'up' ? 'border-emerald-100 bg-emerald-50/60' : card.sentiment === 'down' ? 'border-red-100 bg-red-50/50' : 'border-stone-200 bg-white';
          return (
            <button
              key={card.id}
              type="button"
              disabled={!clickable}
              onClick={() => card.filter && addFilter(card.filter.key, card.filter.value)}
              className={`min-w-[220px] max-w-[280px] shrink-0 rounded-xl border px-4 py-3 text-left shadow-card transition ${tone} ${
                clickable ? 'hover:border-stone-300 hover:bg-stone-50' : 'cursor-default'
              }`}
            >
              <div className="text-sm font-semibold leading-snug text-ink">{card.title}</div>
              {card.detail && <div className="mt-1 text-xs leading-snug text-stone-500">{card.detail}</div>}
              {clickable && <div className="mt-2 text-[11px] font-medium text-stone-400">Filter dashboard →</div>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
