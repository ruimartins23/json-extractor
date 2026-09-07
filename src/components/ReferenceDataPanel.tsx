import { useState, useMemo, useEffect, useRef, Fragment } from 'react';
import { Database, ChevronDown, Search } from 'lucide-react';
import {
  LABELS, toTables, cellText, fullCellText, recordCount, orderedFixtureKeys,
} from '../utils/referenceData';
import type { Table, FixtureFocus } from '../utils/referenceData';

interface ReferenceDataPanelProps {
  data: Record<string, unknown>;
  focus?: FixtureFocus;
}

function DataTable({ table, query, focus }: { table: Table; query: string; focus?: FixtureFocus }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const bodyRef = useRef<HTMLTableSectionElement>(null);

  const toggle = (i: number) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  // React to an external focus request: expand, scroll to, and flash the target row.
  useEffect(() => {
    if (!focus) return;
    setExpanded(prev => new Set(prev).add(focus.rowIndex));
    requestAnimationFrame(() => {
      const el = bodyRef.current?.querySelector<HTMLElement>(`tr[data-row-idx="${focus.rowIndex}"]`);
      if (!el) return;
      el.scrollIntoView({ block: 'center' });
      el.classList.remove('ref-flash');
      void el.offsetWidth;
      el.classList.add('ref-flash');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  const columns = useMemo(() => {
    const seen: string[] = [];
    table.rows.forEach(row => {
      Object.keys(row).forEach(k => {
        if (!seen.includes(k)) seen.push(k);
      });
    });
    return seen;
  }, [table.rows]);

  const rows = table.rows
    .map((row, idx) => ({ row, idx }))
    .filter(({ row }) => !query || JSON.stringify(row).toLowerCase().includes(query));

  return (
    <div className="ref-table-wrap">
      {table.label && <div className="ref-table-label">{table.label}</div>}
      <div className="ref-table-scroll">
        <table className="ref-table">
          <thead>
            <tr>
              <th className="ref-caret-col" aria-label="expand" />
              {columns.map(col => <th key={col}>{col}</th>)}
            </tr>
          </thead>
          <tbody ref={bodyRef}>
            {rows.map(({ row, idx }) => {
              const isOpen = expanded.has(idx);
              return (
                <Fragment key={idx}>
                  <tr className="ref-row" data-row-idx={idx} onClick={() => toggle(idx)} title="Click to see full values">
                    <td className="ref-caret-cell">{isOpen ? '▾' : '▸'}</td>
                    {columns.map(col => <td key={col}>{cellText(row[col])}</td>)}
                  </tr>
                  {isOpen && (
                    <tr className="ref-detail-row">
                      <td colSpan={columns.length + 1}>
                        <div className="ref-detail">
                          {columns.map(col => (
                            <div className="ref-detail-item" key={col}>
                              <span className="ref-detail-key">{col}</span>
                              <span className="ref-detail-val">{fullCellText(row[col])}</span>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <div className="ref-empty">No rows match "{query}".</div>}
    </div>
  );
}

function BlockView({ value, query, focus }: { value: unknown; query: string; focus?: FixtureFocus }) {
  const tables = toTables(value);

  if (tables.length > 0) {
    return (
      <>
        {tables.map((t, i) => (
          <DataTable key={i} table={t} query={query} focus={focus?.tableIndex === i ? focus : undefined} />
        ))}
      </>
    );
  }

  // Non-tabular: primitive or a plain object of key/values.
  if (value && typeof value === 'object') {
    return (
      <div className="ref-kv">
        {Object.entries(value).map(([k, v]) => (
          <div key={k} className="ref-kv-row">
            <span className="ref-kv-key">{k}</span>
            <span className="ref-kv-val">{cellText(v)}</span>
          </div>
        ))}
      </div>
    );
  }

  return <div className="ref-scalar">{cellText(value)}</div>;
}

export function ReferenceDataPanel({ data, focus }: ReferenceDataPanelProps) {
  const keys = useMemo(() => orderedFixtureKeys(data), [data]);

  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState(keys[0]);
  const [query, setQuery] = useState('');

  // A lookup from the timeline opens the panel and jumps to the matching tab.
  useEffect(() => {
    if (!focus) return;
    setOpen(true);
    setActiveTab(focus.block);
  }, [focus?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  if (keys.length === 0) return null;

  const active = keys.includes(activeTab) ? activeTab : keys[0];
  const q = query.trim().toLowerCase();

  return (
    <div className={`reference-panel glass ${open ? "" : "collapsed"}`}>
      <button className="reference-header" onClick={() => setOpen(o => !o)}>
        <Database className="reference-icon" />
        <div className="reference-title-group">
          <h3 className="panel-title">Data fixture</h3>
          <span className="reference-subtitle">Data output by the model</span>
        </div>
        <ChevronDown className={`reference-chevron ${open ? 'open' : ''}`} />
      </button>

      {open && (
        <div className="reference-body animate-fade-in">
          <div className="reference-toolbar">
            <div className="reference-tabs">
              {keys.map(key => {
                const count = recordCount(data[key]);
                return (
                  <button
                    key={key}
                    className={`reference-tab ${active === key ? 'active' : ''}`}
                    onClick={() => setActiveTab(key)}
                  >
                    {LABELS[key] || key}
                    {count > 0 && <span className="reference-tab-count">{count}</span>}
                  </button>
                );
              })}
            </div>
            <div className="reference-search">
              <Search className="filter-search-icon" />
              <input
                type="text"
                className="text-input"
                placeholder="Search this data..."
                value={query}
                onChange={e => setQuery(e.target.value)}
              />
            </div>
          </div>

          <div className="reference-content">
            <BlockView value={data[active]} query={q} focus={focus?.block === active ? focus : undefined} />
          </div>
        </div>
      )}
    </div>
  );
}
