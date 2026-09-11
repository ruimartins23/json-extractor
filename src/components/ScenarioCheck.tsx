import { useState, useMemo, useEffect } from 'react';
import type { CSSProperties } from 'react';
import { ClipboardCheck, ChevronDown, Check, X, ArrowRight } from 'lucide-react';
import type { OrganizedTimeline, ParsedEvent } from '../utils/parser';
import { agentOffset } from '../utils/agentColour';
import { SCENARIOS } from '../data/scenarios';

interface ScenarioCheckProps {
  agentType: OrganizedTimeline['agentType'];
  events: ParsedEvent[];
  /** Scenario chosen on the upload page; adjustable here if it was wrong. */
  scenario?: { num: number; gender: 'male' | 'female' };
}

// Map guideline names and executed tool names to a shared "family" so naming
// differences (get_billing_information vs get_billing_info, plans/features, etc.)
// don't read as mismatches.
const FAMILY: Record<string, string> = {
  get_customer_account_details: 'account_details',
  update_account_information: 'update_account',
  update_acount_information: 'update_account', // guideline typo (scenario 15)
  modify_service_plan_or_feature: 'modify_plan',
  query_available_plans: 'query_plans_features',
  query_available_features: 'query_plans_features',
  query_available_plans_and_features: 'query_plans_features',
  query_available_promotions: 'query_promotions',
  query_orders: 'query_orders',
  get_billing_information: 'billing',
  get_billing_info: 'billing',
  end_session: 'end_session',
  transfer_to_agent: 'transfer',
  agenttransfer: 'transfer',
  transfertoagenttool: 'transfer',
  query_troubleshooting_documents: 'troubleshooting_docs',
  query_troubleshooting_docs: 'troubleshooting_docs',
  // The guideline says "session"; sessions execute "call".
  process_end_of_non_escalated_session: 'end_processing',
  process_end_of_non_escalated_call: 'end_processing',
  process_escalated_session: 'escalated_processing',
  process_escalated_call: 'escalated_processing',
  get_area_network_outage_status: 'outage',
  get_customer_line_status: 'line_status',
  perform_device_action: 'device_action',
  log_support_interaction: 'log_support',
  autopay: 'autopay',
  set_autopay: 'autopay',
};
const FAMILY_NORM: Record<string, string> = {};
for (const [k, v] of Object.entries(FAMILY)) FAMILY_NORM[k.replace(/[^a-z]/g, '')] = v;

function family(name: string): string {
  const norm = name.toLowerCase().replace(/[^a-z]/g, '');
  return FAMILY_NORM[norm] || norm;
}

// Normalize an executing agent name to match the guideline's short form (drops " Agent").
function normAgent(name: string | undefined): string | undefined {
  if (!name) return undefined;
  return name.replace(/\s*Agent$/i, '').trim();
}

function transferTarget(event: ParsedEvent): string {
  const a = event.arguments;
  return normAgent(a?.displayName || a?.targetAgent || a?.agent_name || a?.target || a?.destination || a?.agent) || 'Unknown';
}

// A coloured agent chip; for a transfer it reads "from → to". The colour comes
// from the same slot table as the flow map and the timeline badges, so one
// agent is one colour everywhere on the page.
function AgentTag({ events, agent, target }: { events: ParsedEvent[]; agent?: string; target?: string }) {
  if (!agent && !target) return null;
  const label = agent || '?';
  const style = { '--agent-offset': agentOffset(events, agent || target || '') } as CSSProperties;
  return (
    <span className="scenario-agent" style={style}>
      {label}
      {target && <><ArrowRight className="scenario-agent-arrow" />{target}</>}
    </span>
  );
}

export function ScenarioCheck({ agentType, events, scenario }: ScenarioCheckProps) {
  const kind = agentType === 'prod multi agent' ? 'multi' : 'single';
  const pool = useMemo(() => SCENARIOS.filter(s => s.agentType === kind), [kind]);

  const [open, setOpen] = useState(false);
  const [num, setNum] = useState(scenario?.num ?? 1);
  const [gender, setGender] = useState<'male' | 'female'>(scenario?.gender ?? 'male');

  // A new upload carries a fresh scenario choice from the upload page.
  useEffect(() => {
    if (!scenario) return;
    setNum(scenario.num);
    setGender(scenario.gender);
  }, [scenario]);

  // Available scenario numbers depend on the gender (some scenarios only exist for one).
  const numbers = useMemo(
    () => [...new Set(pool.filter(s => s.gender === gender).map(s => s.num))].sort((a, b) => a - b),
    [pool, gender]
  );
  // If the current number isn't valid for this gender, fall back to the first available.
  const activeNum = numbers.includes(num) ? num : (numbers[0] ?? num);

  const spec = pool.find(s => s.num === activeNum && s.gender === gender);

  // Executed tool calls in order (functions, end-session, transfers), with the agent that ran them.
  const executed = useMemo(
    () =>
      events
        .filter(e => e.type === 'function' || e.type === 'endsession' || e.type === 'transfer')
        .map(e => ({
          name: e.type === 'transfer' ? 'transfer_to_agent' : e.toolName || 'unknown',
          fam: e.type === 'transfer' ? 'transfer' : family(e.toolName || ''),
          agent: normAgent(e.raw?.agent),
          target: e.type === 'transfer' ? transferTarget(e) : undefined,
        })),
    [events]
  );

  // Greedy, order-aware alignment of expected vs executed.
  // "alt" entries match either name; "optional" entries never count as missing.
  const { rows, extras, matched, requiredTotal } = useMemo(() => {
    const used = new Array(executed.length).fill(false);
    let matched = 0;
    let requiredTotal = 0;
    const rows = (spec?.functions ?? []).map(fn => {
      const fams = [family(fn.name), ...(fn.alt ? [family(fn.alt)] : [])];
      if (!fn.optional) requiredTotal++;
      const idx = executed.findIndex((e, i) => !used[i] && fams.includes(e.fam));
      if (idx >= 0) {
        used[idx] = true;
        // An "or" entry is satisfied by either tool, and calling both is fine too:
        // consume the sibling as well so it isn't reported as an extra call.
        const names = [executed[idx].name];
        if (fn.alt) {
          executed.forEach((e, i) => {
            if (!used[i] && fams.includes(e.fam)) {
              used[i] = true;
              names.push(e.name);
            }
          });
        }
        if (!fn.optional) matched++;
        return { fn, status: 'matched' as const, execName: names.join(' + ') };
      }
      return { fn, status: fn.optional ? ('optional' as const) : ('missing' as const), execName: undefined };
    });
    const extras = executed.filter((_, i) => !used[i]);
    return { rows, extras, matched, requiredTotal };
  }, [spec, executed]);

  const total = requiredTotal;
  const allPresent = total > 0 && matched === total;

  return (
    <div className={`scenario-panel glass ${open ? "" : "collapsed"}`}>
      <button className="reference-header" onClick={() => setOpen(o => !o)}>
        <ClipboardCheck className="reference-icon" />
        <div className="reference-title-group">
          <h3 className="panel-title">
            Scenario check
            <span className="beta-tag">beta</span>
          </h3>
          <span className="reference-subtitle">Compare executed functions against the guideline's expected calls</span>
          <span className="beta-note">Still in beta. Not all scenarios are fully tested, so use it carefully. Found an error? Please DM me.</span>
        </div>
        <ChevronDown className={`reference-chevron ${open ? 'open' : ''}`} />
      </button>

      {open && (
        <div className="reference-body animate-fade-in">
          <div className="scenario-picker">
            <label className="scenario-field">
              <span className="field-label">Scenario</span>
              <select className="select-input" value={activeNum} onChange={e => setNum(Number(e.target.value))}>
                {numbers.map(n => {
                  const t = pool.find(s => s.num === n && s.gender === gender)?.title || '';
                  return <option key={n} value={n}>{n}. {t}</option>;
                })}
              </select>
            </label>
            <label className="scenario-field">
              <span className="field-label">Gender</span>
              <div className="segmented-control compact">
                {(['male', 'female'] as const).map(g => (
                  <button
                    key={g}
                    className={`segment-btn ${gender === g ? 'active' : ''}`}
                    onClick={() => setGender(g)}
                  >
                    {g === 'male' ? 'Male' : 'Female'}
                  </button>
                ))}
              </div>
            </label>
          </div>

          {!spec || total === 0 ? (
            <div className="scenario-empty">No expected functions are defined for this scenario.</div>
          ) : (
            <>
              {spec.user && <div className="scenario-user">Expected user: <strong>{spec.user}</strong></div>}

              <div className={`scenario-verdict ${allPresent ? 'ok' : 'warn'}`}>
                {allPresent
                  ? `All ${total} expected function${total > 1 ? 's were' : ' was'} called.`
                  : `${matched} of ${total} expected functions found, ${total - matched} missing.`}
                {extras.length > 0 && ` ${extras.length} extra call${extras.length > 1 ? 's' : ''} not in the expected set.`}
              </div>

              <div className="scenario-cols">
                <div>
                  <div className="scenario-col-title">Expected calls</div>
                  <ol className="scenario-list">
                    {rows.map((row, i) => (
                      <li key={i} className={`scenario-item ${row.status}`}>
                        {row.status === 'matched'
                          ? <Check className="scenario-item-icon ok" />
                          : row.status === 'optional'
                            ? <span className="scenario-item-icon opt">~</span>
                            : <X className="scenario-item-icon bad" />}
                        <span className="scenario-fn">
                          {row.fn.name}
                          {row.fn.alt && <span className="scenario-fn-alt"> and/or {row.fn.alt}</span>}
                        </span>
                        {row.status === 'matched' && row.execName && row.execName !== row.fn.name && (
                          <span className="scenario-alias">executed as {row.execName}</span>
                        )}
                        {row.status === 'missing' && <span className="scenario-missing-tag">missing</span>}
                        {row.status === 'optional' && <span className="scenario-optional-tag">optional, not called</span>}
                        <AgentTag events={events} agent={row.fn.agent} target={row.fn.target} />
                      </li>
                    ))}
                  </ol>
                </div>
                <div>
                  <div className="scenario-col-title">Extra calls ({extras.length})</div>
                  {extras.length === 0 ? (
                    <div className="scenario-none">None. Nothing was called beyond the expected set.</div>
                  ) : (
                    <ul className="scenario-list">
                      {extras.map((e, i) => (
                        <li key={i} className="scenario-item extra">
                          <span className="scenario-item-icon extra">+</span>
                          <span className="scenario-fn">{e.name}</span>
                          <AgentTag events={events} agent={e.agent} target={e.target} />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              {spec.reference && (
                <details className="scenario-reference">
                  <summary>Guideline reference</summary>
                  <p>{spec.reference}</p>
                </details>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
