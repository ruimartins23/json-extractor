import { useState, useMemo, useEffect, useRef, useCallback, Fragment } from 'react';
import type { CSSProperties } from 'react';
import { endSessionIssue } from '../utils/parser';
import { agentOffset } from '../utils/agentColour';
import type { OrganizedTimeline, ParsedEvent, EnvironmentMode, ParserConfig } from '../utils/parser';
import { ReferenceDataPanel } from './ReferenceDataPanel';
import { ScenarioCheck } from './ScenarioCheck';
import { AudioTool } from './AudioTool';
import type { AudioFormat } from '../utils/audio';
import { clearStoredRecording } from '../utils/recordingStore';
import { findFixtureMatch } from '../utils/referenceData';
import type { FixtureFocus } from '../utils/referenceData';
import {
  Activity, Copy, Download, AlertTriangle, Search, MessageSquare, Braces,
  ArrowLeftRight, ArrowRight, ChevronsUpDown, ChevronsDownUp, Check, X, StickyNote,
} from 'lucide-react';

interface TimelineViewProps {
  data: OrganizedTimeline;
  onReset: () => void;
  /** Re-reads the loaded file as a different environment. */
  onModeChange?: (mode: EnvironmentMode) => void;
  /** The keywords the file was read with, and a way to read it again with others. */
  config?: ParserConfig;
  onConfigChange?: (config: ParserConfig) => void;
  scenario?: { num: number; gender: 'male' | 'female' };
  /** Recording picked on the upload page, if the user attached one there. */
  mediaFile?: File | null;
}

const MODE_LABELS: Record<string, string> = {
  'prod multi agent': 'Prod Multi Agent',
  'prod single agent': 'Prod Single Agent',
  'pre-prod': 'Pre-Prod',
};

function useCopyToClipboard(idleLabel: string): [string, (text: string | undefined) => void] {
  const [label, setLabel] = useState(idleLabel);

  const copy = (text: string | undefined) => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    setLabel('Copied!');
    setTimeout(() => setLabel(idleLabel), 2000);
  };

  return [label, copy];
}

function getTransferTarget(event: ParsedEvent): string {
  const args = event.arguments;
  return args?.displayName || args?.targetAgent || args?.agent_name || args?.target || args?.destination || args?.agent || 'Unknown Agent';
}

// Gather primitive leaf values from a tool call's arguments (recursively) for fixture lookup.
function collectLeafValues(value: unknown, acc = new Set<string>()): Set<string> {
  if (value === null || value === undefined) return acc;
  if (Array.isArray(value)) {
    value.forEach(v => collectLeafValues(v, acc));
  } else if (typeof value === 'object') {
    Object.values(value).forEach(v => collectLeafValues(v, acc));
  } else {
    const s = String(value).trim();
    if (s.length >= 3 && !/^(true|false)$/i.test(s)) acc.add(s);
  }
  return acc;
}

interface FlowSegment {
  agent: string;
  count: number;
  startIndex: number;
}

// Collapse the event list into "who owned the conversation between handoffs".
// Only transfers start a new segment, so a call whose timestamp lands on the wrong
// side of a handoff doesn't split the map into phantom segments.
function buildFlowSegments(events: ParsedEvent[]): FlowSegment[] {
  const segments: FlowSegment[] = [];
  let nextAgent: string | null = null;

  const agentHint = (event: ParsedEvent): string | null => {
    if (event.type === 'message') {
      const role = (event.messageRole || '').toLowerCase();
      if (role && role !== 'user' && role !== 'system' && role !== 'agent') return event.messageRole!;
      return null;
    }
    return event.raw?.agent || null;
  };

  events.forEach((event, i) => {
    let seg = segments[segments.length - 1];
    if (!seg) {
      seg = { agent: nextAgent || 'Session Start', count: 0, startIndex: i };
      segments.push(seg);
    }
    seg.count++;

    // Name the opening segment from the first agent we can actually see.
    if (seg.agent === 'Session Start') {
      const hint = agentHint(event);
      if (hint) seg.agent = hint;
    }

    // The transfer belongs to the agent handing off; the target owns what follows.
    if (event.type === 'transfer') {
      nextAgent = getTransferTarget(event);
      segments.push({ agent: nextAgent, count: 0, startIndex: i + 1 });
    }
  });

  // Drop a trailing segment when the session ends on a transfer.
  if (segments.length > 0 && segments[segments.length - 1].count === 0) segments.pop();

  return segments;
}

function jumpToEvent(globalIndex: number) {
  const el = document.getElementById(`event-row-${globalIndex}`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('flash');
  // Restart the flash animation even when jumping to the same row twice
  void el.offsetWidth;
  el.classList.add('flash');
}

function formatOffset(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `+${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

// Ensure sections are separated by a blank line before appending.
function withSectionBreak(text: string): string {
  if (text.length === 0 || text.endsWith('\n\n')) return text;
  return text + (text.endsWith('\n') ? '\n' : '\n\n');
}

export type ReviewStatus = 'correct' | 'incorrect';
export type ReviewKind = 'function' | 'transfer';

type SummaryLine =
  | { kind: 'blank' }
  | { kind: 'text'; text: string }
  | { kind: 'function'; key: string; num: number; name: string }
  | { kind: 'transfer'; key: string; text: string };

// Every event is keyed by its index in data.events, so the timeline rows, the
// summary lines, review status, and per-turn notes all reference the same event.
const eventKeyFor = (index: number) => `ev-${index}`;

function statusSuffix(status: ReviewStatus | undefined, kind: ReviewKind): string {
  if (status === 'correct') return kind === 'transfer' ? '(correct)' : '(correct parameters)';
  if (status === 'incorrect') return '(incorrect)';
  return ''; // unreviewed: no suffix, just the name
}

// Flatten the structured summary into copyable text, applying review statuses.
function summaryLinesToText(lines: SummaryLine[], statuses: Record<string, ReviewStatus>): string {
  return lines
    .map(line => {
      if (line.kind === 'blank') return '';
      if (line.kind === 'text') return line.text;
      if (line.kind === 'transfer') return `${line.text} ${statusSuffix(statuses[line.key], 'transfer')}`.trim();
      return `${line.num}. ${line.name} ${statusSuffix(statuses[line.key], 'function')}`.trim();
    })
    .join('\n')
    .trim();
}

function buildOutputs(data: OrganizedTimeline, dropped: Record<string, boolean>) {
  const summaryLines: SummaryLine[] = [];
  let displayTranscript = '';
  let downloadTranscript = '';
  let counter = 1;
  let currentAgent: string | null = null; // null = single-agent mode, no agent headers

  const isMultiAgent = data.agentType === 'prod multi agent';
  if (isMultiAgent) currentAgent = '';

  // Add a blank separator line unless one is already there or the list is empty.
  const ensureBlank = () => {
    const last = summaryLines[summaryLines.length - 1];
    if (last && last.kind !== 'blank') summaryLines.push({ kind: 'blank' });
  };

  const appendMessage = (event: ParsedEvent) => {
    displayTranscript = withSectionBreak(displayTranscript);
    downloadTranscript = withSectionBreak(downloadTranscript);

    const displayRole = event.messageRole
      ? event.messageRole.charAt(0).toUpperCase() + event.messageRole.slice(1)
      : 'System';
    const roleLower = displayRole.toLowerCase();
    // Downloads keep generic roles so agent names never leak into exported transcripts
    const downloadRole = roleLower === 'user' || roleLower === 'system' ? displayRole : 'Agent';

    displayTranscript += `${displayRole}: ${event.messageContent}\n`;
    downloadTranscript += `${downloadRole}: ${event.messageContent}\n`;
  };

  data.events.forEach((event, idx) => {
    // A call the reviewer marked as not counting leaves the list entirely, so the
    // numbering closes up behind it.
    if (event.type !== 'message' && dropped[eventKeyFor(idx)]) return;

    if (event.type === 'message') {
      appendMessage(event);
    } else if (event.type === 'transfer' && isMultiAgent) {
      const from = event.raw?.agent || 'Unknown Agent';
      // Keep back-to-back transfers grouped: only separate from a preceding non-transfer line.
      if (summaryLines[summaryLines.length - 1]?.kind !== 'transfer') ensureBlank();
      summaryLines.push({ kind: 'transfer', key: eventKeyFor(idx), text: `transfer_to_agent (${from} to ${getTransferTarget(event)})` });
      currentAgent = ''; // Force the next function to print its agent header
    } else if (event.type === 'function' || event.type === 'endsession') {
      if (isMultiAgent) {
        const agent = event.raw?.agent || 'Unknown Agent';
        if (agent !== currentAgent) {
          ensureBlank();
          summaryLines.push({ kind: 'text', text: `${agent}:` });
          summaryLines.push({ kind: 'blank' });
          currentAgent = agent;
        }
      }
      summaryLines.push({
        kind: 'function',
        key: eventKeyFor(idx),
        num: counter,
        name: event.toolName || 'Unknown Function',
      });
      counter++;
    }
  });

  return {
    summaryLines,
    displayTranscriptText: displayTranscript.trim(),
    downloadTranscriptText: downloadTranscript.trim(),
  };
}

function downloadFile(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** A keyword the parser hunts for. Chips cover the usual pair; typing covers the rest. */
function KeywordField({ label, value, options, onApply }: {
  label: string;
  value: string;
  options: string[];
  onApply: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  // Follow the value when the file is re-read under different settings.
  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    const next = draft.trim();
    if (next && next !== value) onApply(next);
    else setDraft(value);
  };

  return (
    <div className="keyword-field">
      <label className="field-label">{label}</label>
      <input
        className="text-input"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setDraft(value);
        }}
      />
      <div className="chip-row">
        {options.map(option => (
          <button
            key={option}
            className={`keyword-chip ${value === option ? 'active' : ''}`}
            onClick={() => onApply(option)}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

export function TimelineView({
  data,
  onReset,
  onModeChange,
  config,
  onConfigChange,
  scenario,
  mediaFile,
}: TimelineViewProps) {
  const [showKeywords, setShowKeywords] = useState(false);
  const [copySummaryLabel, copySummary] = useCopyToClipboard('Copy summary');
  const [copyTranscriptLabel, copyTranscript] = useCopyToClipboard('Copy transcript');
  const [copySessionLabel, copySession] = useCopyToClipboard('Copy');
  const [copyDurationLabel, copyDuration] = useCopyToClipboard('Copy');

  const [selectedAgent, setSelectedAgent] = useState<'A' | 'B'>('A');
  const [taskNumber, setTaskNumber] = useState('');
  const [clarity, setClarity] = useState<'Clear' | 'Noisy'>('Clear');

  const [showTranscripts, setShowTranscripts] = useState(true);
  const [showFunctions, setShowFunctions] = useState(true);
  const [showTransfers, setShowTransfers] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandSignal, setExpandSignal] = useState({ version: 0, open: false });
  const [reviewStatus, setReviewStatus] = useState<Record<string, ReviewStatus>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  // Calls the reviewer has taken out of the summary, keyed the same as reviews.
  const [dropped, setDropped] = useState<Record<string, boolean>>({});
  const [fixtureFocus, setFixtureFocus] = useState<FixtureFocus | undefined>();
  const audioEncoderRef = useRef<((onProgress?: (f: number) => void) => Promise<Blob>) | null>(null);
  const [audioReady, setAudioReady] = useState(false);
  const [audioProgress, setAudioProgress] = useState<number | null>(null);

  const setAudioEncoder = useCallback((fn: ((onProgress?: (f: number) => void) => Promise<Blob>) | null) => {
    audioEncoderRef.current = fn;
    setAudioReady(!!fn);
  }, []);
  const [audioFormat, setAudioFormat] = useState<AudioFormat>('m4a');

  // A fresh upload clears any prior review marks and notes.
  useEffect(() => {
    setReviewStatus({});
    setNotes({});
    setDropped({});
    setFixtureFocus(undefined);
  }, [data]);

  const toggleDrop = (key: string) =>
    setDropped(prev => ({ ...prev, [key]: !prev[key] }));

  const focusFixture = (match: { block: string; tableIndex: number; rowIndex: number }) => {
    setFixtureFocus({ ...match, nonce: Date.now() });
  };

  const toggleReview = (key: string, status: ReviewStatus) => {
    setReviewStatus(prev => {
      const next = { ...prev };
      if (next[key] === status) delete next[key]; // clicking the active state again clears it
      else next[key] = status;
      return next;
    });
  };

  const setNote = (key: string, value: string) => {
    setNotes(prev => {
      const next = { ...prev };
      if (value.trim()) next[key] = value;
      else delete next[key];
      return next;
    });
  };

  const taskStr = taskNumber.trim() || '(task number)';
  const summaryFileName = `Telco-AM-${taskStr}-${clarity}-JSON-${selectedAgent}.txt`;
  const transcriptFileName = `Telco-AM-${taskStr}-${clarity}-Transcript-${selectedAgent}.txt`;
  const audioBaseName = `Telco-AM-${taskStr}-${clarity}-Audio-${selectedAgent}`;
  const audioFileName = `${audioBaseName}.${audioFormat}`;

  const stats = useMemo(() => {
    const counts = { functions: 0, transfers: 0, messages: 0 };
    data.events.forEach(e => {
      if (e.type === 'function') counts.functions++;
      else if (e.type === 'transfer') counts.transfers++;
      else if (e.type === 'message') counts.messages++;
    });
    return counts;
  }, [data.events]);

  const { summaryLines, displayTranscriptText, downloadTranscriptText } = useMemo(
    () => buildOutputs(data, dropped),
    [data, dropped]
  );

  const summaryText = useMemo(
    () => summaryLinesToText(summaryLines, reviewStatus),
    [summaryLines, reviewStatus]
  );

  const reviewableCount = useMemo(
    () => summaryLines.filter(l => l.kind === 'function' || l.kind === 'transfer').length,
    [summaryLines]
  );
  const reviewedCount = summaryLines.filter(
    line => (line.kind === 'function' || line.kind === 'transfer') && reviewStatus[line.key],
  ).length;

  const flowSegments = useMemo(() => buildFlowSegments(data.events), [data.events]);

  const sessionStartMs = useMemo(() => {
    const times = data.events
      .map(e => (e.timestamp ? new Date(e.timestamp).getTime() : NaN))
      .filter(t => !isNaN(t));
    return times.length > 0 ? Math.min(...times) : null;
  }, [data.events]);

  const handleDownloadJson = () => {
    if (data.rawJsonText) downloadFile(data.rawJsonText, summaryFileName);
  };

  /** Encodes on demand so the download always matches the current trim. */
  const handleDownloadAudio = async () => {
    const encode = audioEncoderRef.current;
    if (!encode || audioProgress !== null) return;
    setAudioProgress(0);
    try {
      const blob = await encode(setAudioProgress);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = audioFileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      // The take is on disk as a real file now, so the safety copy can go.
      void clearStoredRecording().catch(() => {});
    } finally {
      setAudioProgress(null);
    }
  };

  const handleDownloadTranscript = () => {
    if (downloadTranscriptText) downloadFile(downloadTranscriptText, transcriptFileName);
  };

  const query = searchQuery.trim().toLowerCase();
  const matchesQuery = (event: ParsedEvent) =>
    !query ||
    (event.toolName || '').toLowerCase().includes(query) ||
    (event.messageContent || '').toLowerCase().includes(query) ||
    String(event.raw?.agent || '').toLowerCase().includes(query) ||
    (event.type === 'transfer' && getTransferTarget(event).toLowerCase().includes(query));

  const visibleEvents = data.events
    .map((event, globalIndex) => ({ event, globalIndex }))
    .filter(({ event }) => {
      if (event.type === 'message' && !showTranscripts) return false;
      if (event.type === 'transfer' && !showTransfers) return false;
      if (event.type !== 'message' && event.type !== 'transfer' && !showFunctions) return false;
      return matchesQuery(event);
    });

  return (
    <div className="animate-fade-in" style={{ width: '100%' }}>
      <div className="session-header glass">
        <div className="session-header-top">
          <h2 className="timeline-title">
            <Activity className="timeline-title-icon" />
            Session analysis
          </h2>
          {onModeChange ? (
            <select
              className={`header-mode ${data.agentType === 'prod multi agent' ? 'accent' : ''}`}
              value={data.agentType}
              title="Read this file again as a different environment"
              onChange={e => onModeChange(e.target.value as EnvironmentMode)}
            >
              {Object.entries(MODE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          ) : (
            <span className={`badge ${data.agentType === 'prod multi agent' ? 'accent' : 'primary'}`}>
              {MODE_LABELS[data.agentType] || 'Unknown'}
            </span>
          )}
          <span className="header-events">{data.events.length} events</span>
          {config && onConfigChange && (
            <button className="link-btn" onClick={() => setShowKeywords(v => !v)}>
              {showKeywords ? 'Hide tool keywords' : 'Tool keywords'}
            </button>
          )}
          <button onClick={onReset} className="btn-secondary header-reset">
            Upload a new file
          </button>
        </div>

        {showKeywords && config && onConfigChange && (
          <div className="header-keywords animate-fade-in">
            <KeywordField
              label="Function tool"
              value={config.functionKeyword}
              options={['toolCall', 'PythonFunctionTool']}
              onApply={v => onConfigChange({ ...config, functionKeyword: v })}
            />
            {data.agentType === 'prod multi agent' && (
              <KeywordField
                label="Transfer tool"
                value={config.transferKeyword}
                options={['agentTransfer', 'TransferToAgentTool']}
                onApply={v => onConfigChange({ ...config, transferKeyword: v })}
              />
            )}
            {data.agentType !== 'pre-prod' && (
              <KeywordField
                label="End session tool"
                value={config.endSessionKeyword}
                options={['toolCall', 'EndSessionTool']}
                onApply={v => onConfigChange({ ...config, endSessionKeyword: v })}
              />
            )}
            <p className="header-keywords-note">
              Changing these reads the file again and clears any review marks.
            </p>
          </div>
        )}

        {(data.sessionId || data.duration) && (
          <div className="facts-primary">
            {data.sessionId && (
              <div className="fact meta">
                <span className="fact-label">Session ID</span>
                <button className="fact-mono copyable" onClick={() => copySession(data.sessionId)} title="Click to copy">
                  {data.sessionId}
                </button>
                <button onClick={() => copySession(data.sessionId)} className="btn-secondary fact-copy">
                  <Copy className="btn-icon-sm" /> {copySessionLabel}
                </button>
              </div>
            )}
            {data.duration && (
              <div className="fact meta">
                <span className="fact-label">Duration</span>
                <button className="fact-mono copyable" onClick={() => copyDuration(data.duration)} title="Click to copy">
                  {data.duration}
                </button>
                <button onClick={() => copyDuration(data.duration)} className="btn-secondary fact-copy">
                  <Copy className="btn-icon-sm" /> {copyDurationLabel}
                </button>
              </div>
            )}
          </div>
        )}

        <div className="facts-secondary">
        <div className="fact">
          <MessageSquare className="fact-icon" />
          <span className="fact-value">{stats.messages}</span>
          <span className="fact-label">Transcript turns</span>
        </div>
        <div className="fact">
          <Braces className="fact-icon" />
          <span className="fact-value">{stats.functions}</span>
          <span className="fact-label">Functions</span>
        </div>
        {data.agentType === 'prod multi agent' && (
          <div className="fact">
            <ArrowLeftRight className="fact-icon" />
            <span className="fact-value">{stats.transfers}</span>
            <span className="fact-label">Transfers</span>
          </div>
        )}

        </div>
      </div>

      {data.transcriptNotes && data.transcriptNotes.length > 0 && (
        <div className="glass warning-banner info">
          <AlertTriangle className="icon" />
          <div>
            <h3>Check this transcript</h3>
            {data.transcriptNotes.map(note => (
              <p key={note}>{note}</p>
            ))}
          </div>
        </div>
      )}

      {data.hasEnvironmentMismatch && (
        <div className="glass warning-banner">
          <AlertTriangle className="icon" />
          <div>
            <h3>Environment Mismatch</h3>
            <p>
              This file has agent transfers in it, so it is a multi-agent session, but it was read
              as single agent. Switch the environment at the top of this card to fix it, no need to
              upload anything again.
            </p>
          </div>
        </div>
      )}

      <AudioTool
        initialFile={mediaFile}
        format={audioFormat}
        onFormatChange={setAudioFormat}
        onEncoderChange={setAudioEncoder}
      />

      <div className="export-section glass">
        <div className="export-header">
          <div className="export-controls">
            <h3 className="panel-title">
              <Download className="icon" />
              Export options
            </h3>

            <div className="export-options-row">
              <div className="export-option">
                <span className="export-option-label">Agent target:</span>
                <div className="segmented-control compact">
                  {(['A', 'B'] as const).map(agent => (
                    <button
                      key={agent}
                      className={`segment-btn ${selectedAgent === agent ? 'active' : ''}`}
                      onClick={() => setSelectedAgent(agent)}
                    >
                      {agent}
                    </button>
                  ))}
                </div>
              </div>

              <div className="export-option">
                <span className="export-option-label">Task number:</span>
                <input
                  type="text"
                  value={taskNumber}
                  onChange={(e) => setTaskNumber(e.target.value)}
                  placeholder="e.g. 12"
                  /* Without it every file is named "(task number)", which is easy to miss. */
                  className={`text-input ${taskNumber.trim() ? '' : 'needed'}`}
                />
              </div>

              <div className="export-option">
                <span className="export-option-label">Task type:</span>
                <select
                  value={clarity}
                  onChange={(e) => setClarity(e.target.value as 'Clear' | 'Noisy')}
                  className="select-input"
                >
                  <option value="Clear">Clear</option>
                  <option value="Noisy">Noisy</option>
                </select>
              </div>
            </div>
          </div>

          <button
            onClick={async () => { handleDownloadJson(); handleDownloadTranscript(); await handleDownloadAudio(); }}
            className="btn-primary"
          >
            <Download className="btn-icon" />
            Download all
          </button>
        </div>

        <div className="export-cards">
          <div className="export-card">
            <span className="export-card-title">Raw JSON file</span>
            <span className="export-card-filename">{summaryFileName}</span>
            <button onClick={handleDownloadJson} className="btn-secondary">
              <Download className="btn-icon" />
              Download JSON
            </button>
          </div>

          <div className="export-card">
            <span className="export-card-title">Transcript text</span>
            <span className="export-card-filename">{transcriptFileName}</span>
            <button onClick={handleDownloadTranscript} className="btn-secondary">
              <Download className="btn-icon" />
              Download transcript
            </button>
          </div>

          <div className="export-card">
            <span className="export-card-title">Audio file</span>
            <span className="export-card-filename">
              {audioReady ? audioFileName : 'Load a recording in the Audio panel above'}
            </span>
            <button onClick={handleDownloadAudio} className="btn-secondary" disabled={!audioReady || audioProgress !== null}>
              <Download className="btn-icon" />
              {audioProgress !== null ? `Converting ${Math.round(audioProgress * 100)}%` : 'Download audio'}
            </button>
          </div>
        </div>
      </div>

      <div className="output-grid">
        <div className="summary-box glass">
          <div className="summary-box-header">
            <h3 className="panel-title">Function &amp; transfer summary</h3>
            <button onClick={() => copySummary(summaryText)} className="btn-secondary">
              <Copy className="btn-icon-sm" />
              {copySummaryLabel}
            </button>
          </div>
          {reviewableCount > 0 && (
            <div className="review-hint">
              <span>Mark each call <Check className="review-hint-icon ok" /> or <X className="review-hint-icon bad" /> in the timeline below.</span>
              <span className="review-progress">{reviewedCount}/{reviewableCount} reviewed</span>
            </div>
          )}
          <div className="summary-review">
            {summaryLines.map((line, i) => {
              if (line.kind === 'blank') return <div key={i} className="review-blank" />;
              if (line.kind === 'text') {
                return <div key={i} className="review-text agent-header">{line.text}</div>;
              }
              if (line.kind === 'transfer') {
                const status = reviewStatus[line.key];
                return (
                  <div key={i} className={`review-text transfer ${status || ''}`}>
                    {line.text}{status && <> <span className="review-fn-suffix">{statusSuffix(status, 'transfer')}</span></>}
                  </div>
                );
              }
              const status = reviewStatus[line.key];
              return (
                <div key={i} className={`review-fn ${status || ''}`}>
                  <span className="review-fn-num">{line.num}.</span>
                  <span className="review-fn-name">{line.name}</span>
                  {status && <span className="review-fn-suffix">{statusSuffix(status, 'function')}</span>}
                </div>
              );
            })}
          </div>
        </div>

        <div className="summary-box glass">
          <div className="summary-box-header">
            <h3 className="panel-title">Transcript</h3>
            <button onClick={() => copyTranscript(downloadTranscriptText)} className="btn-secondary">
              <Copy className="btn-icon-sm" />
              {copyTranscriptLabel}
            </button>
          </div>
          <textarea readOnly value={displayTranscriptText} className="output-textarea" />
        </div>
      </div>
      {data.agentType === 'prod multi agent' && flowSegments.length > 1 && (
        <div className="flow-map glass">
          <span className="flow-map-label">Session Flow</span>
          <div className="flow-track">
            {flowSegments.map((segment, i) => (
              <Fragment key={i}>
                {i > 0 && <ArrowRight className="flow-arrow" />}
                <button
                  className="flow-segment"
                  style={{ '--agent-offset': agentOffset(data.events, segment.agent.toLowerCase()), flexGrow: segment.count } as CSSProperties}
                  onClick={() => jumpToEvent(segment.startIndex)}
                  title={`${segment.agent}, ${segment.count} event${segment.count > 1 ? 's' : ''} (click to jump)`}
                >
                  {segment.agent} <span className="flow-count">({segment.count})</span>
                </button>
              </Fragment>
            ))}
          </div>
        </div>
      )}

      <ScenarioCheck agentType={data.agentType} events={data.events} scenario={scenario} />

      {data.referenceData && <ReferenceDataPanel data={data.referenceData} focus={fixtureFocus} />}

      <div className="filter-bar glass">
        <span className="filter-bar-label">Filters:</span>
        <label className="checkbox-label">
          <input type="checkbox" checked={showTranscripts} onChange={e => setShowTranscripts(e.target.checked)} />
          Show transcripts
        </label>
        <label className="checkbox-label">
          <input type="checkbox" checked={showFunctions} onChange={e => setShowFunctions(e.target.checked)} />
          Show functions &amp; tools
        </label>
        {data.agentType === 'prod multi agent' && (
          <label className="checkbox-label">
            <input type="checkbox" checked={showTransfers} onChange={e => setShowTransfers(e.target.checked)} />
            Show Transfers
          </label>
        )}
        <div className="filter-search">
          <Search className="filter-search-icon" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search events..."
            className="text-input"
          />
          <span className="filter-count">{visibleEvents.length}/{data.events.length}</span>
        </div>
        <div className="filter-expand-btns">
          <button
            className="btn-secondary"
            title="Expand all details"
            onClick={() => setExpandSignal(s => ({ version: s.version + 1, open: true }))}
          >
            <ChevronsUpDown className="btn-icon-sm" />
          </button>
          <button
            className="btn-secondary"
            title="Collapse all details"
            onClick={() => setExpandSignal(s => ({ version: s.version + 1, open: false }))}
          >
            <ChevronsDownUp className="btn-icon-sm" />
          </button>
        </div>
      </div>

      <div className="timeline-list">
        {visibleEvents.map(({ event, globalIndex }, idx) => (
          <TimelineItem
            key={event.id || globalIndex}
            event={event}
            index={idx}
            globalIndex={globalIndex}
            expandSignal={expandSignal}
            reviewStatus={reviewStatus[eventKeyFor(globalIndex)]}
            onReview={toggleReview}
            note={notes[eventKeyFor(globalIndex)]}
            onNote={setNote}
            counted={!dropped[eventKeyFor(globalIndex)]}
            onToggleCount={toggleDrop}
            allEvents={data.events}
            referenceData={data.referenceData}
            onFixtureFocus={focusFixture}
            offsetLabel={
              sessionStartMs !== null && event.timestamp
                ? formatOffset(new Date(event.timestamp).getTime() - sessionStartMs)
                : undefined
            }
          />
        ))}
        {data.events.length === 0 && (
          <div className="timeline-empty glass">
            No supported tools or events found in this JSON file.
          </div>
        )}
        {data.events.length > 0 && visibleEvents.length === 0 && (
          <div className="timeline-empty glass">
            No events match the current filters.
          </div>
        )}
      </div>
    </div>
  );
}

const EVENT_BADGES: Record<string, { label: string; variant: string }> = {
  function: { label: 'TOOL', variant: 'diag' },
  transfer: { label: 'TRANSFER', variant: 'accent' },
  endsession: { label: 'END', variant: 'destructive' },
  tool_response: { label: 'RESPONSE', variant: 'success' },
};

interface TimelineItemProps {
  event: ParsedEvent;
  index: number;
  globalIndex: number;
  expandSignal: { version: number; open: boolean };
  reviewStatus?: ReviewStatus;
  onReview: (key: string, status: ReviewStatus) => void;
  note?: string;
  onNote: (key: string, value: string) => void;
  counted: boolean;
  onToggleCount: (key: string) => void;
  /** Needed to tell a lone end_session apart from one of several. */
  allEvents: ParsedEvent[];
  referenceData?: Record<string, unknown>;
  onFixtureFocus: (match: { block: string; tableIndex: number; rowIndex: number }) => void;
  offsetLabel?: string;
}

function TimelineItem({ event, index, globalIndex, expandSignal, reviewStatus, onReview, note, onNote, counted, onToggleCount, allEvents, referenceData, onFixtureFocus, offsetLabel }: TimelineItemProps) {
  const [expanded, setExpanded] = useState(false);
  // Open by default if this row already has a note; can be collapsed without losing it.
  const [noteOpen, setNoteOpen] = useState(!!note);

  const isMessage = event.type === 'message';
  const hasDetails = !isMessage && !!(event.arguments || event.response || event.raw);

  // Argument values that map to a fixture record, for one-click lookup.
  const fixtureLookups = useMemo(() => {
    if (!referenceData || !event.arguments) return [];
    const out: { value: string; block: string; tableIndex: number; rowIndex: number; blockLabel: string }[] = [];
    for (const value of collectLeafValues(event.arguments)) {
      const match = findFixtureMatch(referenceData, value);
      if (match) out.push({ value, ...match });
    }
    return out.slice(0, 8);
  }, [referenceData, event.arguments]);

  // Functions, end-session and transfers can be marked correct/incorrect inline.
  const isReviewable = event.type === 'function' || event.type === 'endsession' || event.type === 'transfer';
  const reviewKind: ReviewKind = event.type === 'transfer' ? 'transfer' : 'function';
  const eventKey = eventKeyFor(globalIndex);
  const hasNote = !!note;

  useEffect(() => {
    if (expandSignal.version > 0 && hasDetails) {
      setExpanded(expandSignal.open);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandSignal]);

  const eventBadge = EVENT_BADGES[event.type] || { label: 'UNKNOWN', variant: 'diag' };
  const role = (event.messageRole || 'system').toLowerCase();

  let badgeVariant = eventBadge.variant;
  let badgeStyle: CSSProperties | undefined;
  if (isMessage) {
    if (role === 'user') {
      badgeVariant = 'primary';
    } else if (role === 'system' || role === 'agent') {
      badgeVariant = 'accent';
    } else {
      // Named agents each get a colour slot of their own
      badgeVariant = 'agent';
      badgeStyle = { '--agent-offset': agentOffset(allEvents, role) } as CSSProperties;
    }
  }
  const badgeText = isMessage
    ? (event.messageRole ? event.messageRole.toUpperCase() : 'SYSTEM')
    : eventBadge.label;

  const toggleDetails = () => {
    if (hasDetails) setExpanded(prev => !prev);
  };

  return (
    <div
      id={`event-row-${globalIndex}`}
      className={`${counted ? '' : 'not-counted '}timeline-row type-${event.type} animate-slide-up ${reviewStatus ? `review-${reviewStatus}` : ''}`}
      style={{ animationDelay: `${Math.min(index * 40, 800)}ms` }}
    >
      <div className="timeline-row-main">
        <span className="badge-col">
          <span
            className={`badge ${badgeVariant} ${hasDetails ? 'clickable' : ''}`}
            style={badgeStyle}
            onClick={toggleDetails}
          >
            {badgeText}
          </span>
        </span>

        {!isMessage && (
          <div className="tool-line" onClick={toggleDetails}>
            <span className={`tool-line-caret ${expanded ? 'expanded' : ''}`}>&#9656;</span>
            <span className="tool-line-name">
              {event.toolName || (event.type === 'tool_response' ? 'Tool Response Output' : 'Unknown Tool')}
            </span>
            {event.type === 'transfer' && (
              <span className="tool-line-detail">
                (From {event.raw?.agent || 'Unknown'} to {getTransferTarget(event)})
              </span>
            )}
            {event.duplicateCount && event.duplicateCount > 1 && (
              <span className="tool-line-count">({event.duplicateCount}x)</span>
            )}
            {endSessionIssue(event, allEvents) && (
              <>
                <span className="tool-line-warn" title={`end_session ${endSessionIssue(event, allEvents)}`}>
                  <AlertTriangle className="btn-icon-sm" />
                  executed without a valid response
                </span>
                <label
                  className="count-toggle"
                  title="Untick to leave this call out of the Function and Transfer Summary you copy"
                  onClick={e => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={counted}
                    onChange={() => onToggleCount(eventKeyFor(globalIndex))}
                  />
                  Include in summary
                </label>
              </>
            )}
            {reviewStatus && (
              <span className={`tool-review-suffix ${reviewStatus}`}>
                {statusSuffix(reviewStatus, reviewKind)}
              </span>
            )}
          </div>
        )}
        {isReviewable && (
          <div className="row-review">
            <button
              className={`review-btn ok ${reviewStatus === 'correct' ? 'active' : ''}`}
              title={reviewKind === 'transfer' ? 'Correct' : 'Correct parameters'}
              onClick={(e) => { e.stopPropagation(); onReview(eventKey, 'correct'); }}
            >
              <Check className="btn-icon-sm" />
            </button>
            <button
              className={`review-btn bad ${reviewStatus === 'incorrect' ? 'active' : ''}`}
              title="Incorrect"
              onClick={(e) => { e.stopPropagation(); onReview(eventKey, 'incorrect'); }}
            >
              <X className="btn-icon-sm" />
            </button>
          </div>
        )}
        <button
          className={`note-btn ${hasNote ? 'has-note' : ''}`}
          title={noteOpen ? 'Hide note' : hasNote ? 'Show note' : 'Add note'}
          onClick={(e) => { e.stopPropagation(); setNoteOpen(o => !o); }}
        >
          <StickyNote className="btn-icon-sm" />
        </button>
        {offsetLabel && <span className="event-offset">{offsetLabel}</span>}
      </div>

      {isMessage && <div className="message-content">{event.messageContent}</div>}

      {noteOpen && (
        <div className="note-editor animate-fade-in">
          <StickyNote className="note-editor-icon" />
          <textarea
            className="note-textarea"
            placeholder="Add a note about this turn..."
            value={note || ''}
            autoFocus={!hasNote}
            onChange={(e) => onNote(eventKey, e.target.value)}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {expanded && hasDetails && (
        <div className="event-details animate-fade-in">
          {event.arguments && (
            <div className="data-block args">
              <div className="data-label">Arguments</div>
              <pre>{typeof event.arguments === 'string' ? event.arguments : JSON.stringify(event.arguments, null, 2)}</pre>
            </div>
          )}
          {fixtureLookups.length > 0 && (
            <div className="fixture-lookups">
              <span className="fixture-lookups-label">Look up in fixture:</span>
              {fixtureLookups.map((lookup, i) => (
                <button
                  key={i}
                  className="fixture-chip"
                  title={`Show ${lookup.value} in ${lookup.blockLabel}`}
                  onClick={(e) => { e.stopPropagation(); onFixtureFocus(lookup); }}
                >
                  {lookup.value}
                  <span className="fixture-chip-block">{lookup.blockLabel}</span>
                </button>
              ))}
            </div>
          )}
          {event.response && (
            <div className="data-block resp">
              <div className="data-label">Response</div>
              <pre>{typeof event.response === 'string' ? event.response : JSON.stringify(event.response, null, 2)}</pre>
            </div>
          )}

          <details>
            <summary className="raw-data-summary">View Raw Event JSON</summary>
            <div className="raw-data-block">
              <pre>{JSON.stringify(event.raw, null, 2)}</pre>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
