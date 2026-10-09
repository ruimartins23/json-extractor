/**
 * When each line was actually spoken, read from the per-turn trace spans.
 *
 * A line's stamp is not where it starts being heard. The user's is stamped once
 * the recogniser had the whole sentence, so after they finished. The agent's is
 * stamped at the end of what it said in some sessions and at the start in
 * others, and its voice can queue behind another agent's. The trace for each
 * turn records where the speech really was, so a line can be found from its
 * first word instead:
 *
 * - the user's speech: "start of speech offset (ms)" and "end of speech offset
 *   (ms)", measured from the start of the call (the earliest root span);
 * - each stretch of agent voice: its span's start plus "time to first audio (ms)",
 *   lasting "audio duration (ms)", spoken by the span's "agent".
 */

/** Stretches of speech in the call, in ms since the epoch. */
export interface CallSpeech {
  user: [number, number][];
  agent: [number, number][];
}

export interface SpeechTiming {
  /** When each transcript chunk's line starts being said, keyed by the chunk object. */
  starts: Map<object, number>;
  speech: CallSpeech;
}

/** A stretch of agent voice, in ms since the epoch. */
interface Voice {
  /** When the call produced it. */
  produced: number;
  /** When it was heard: after any voice still playing ahead of it. */
  start: number;
  duration: number;
  /** Who spoke, as a line's role names them ("Billing (Talker)" is "billing"). */
  agent: string;
}

interface Line {
  role: string;
  at: number;
  chunks: object[];
}

interface Turn {
  start: number;
  /** The user's speech, ms from the start of the call; a pause can split it in two. */
  vads: { start: number; end: number }[];
  voices: Voice[];
  lines: Line[];
}

/** Shorter than this is a blip of silence the trace logs as voice, never a line. */
const BLIP_MS = 250;

const time = (value: unknown): number => (typeof value === 'string' ? new Date(value).getTime() : NaN);
const speaker = (name: string) => name.replace(/\s*\((talker|thinker)\)\s*$/i, '').trim().toLowerCase();

function collectTurns(node: unknown, out: Record<string, any>[]): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach(item => collectTurns(item, out));
    return;
  }
  const obj = node as Record<string, any>;
  if (obj.rootSpan && typeof obj.rootSpan === 'object' && Array.isArray(obj.messages)) out.push(obj);
  for (const value of Object.values(obj)) if (value && typeof value === 'object') collectTurns(value, out);
}

function readTurn(info: Record<string, any>): Turn | null {
  const span = info.rootSpan;
  const start = time(span.startTime);
  if (isNaN(start)) return null;
  const children: any[] = Array.isArray(span.childSpans) ? span.childSpans : [];

  const vads = children
    .filter(c => typeof c?.attributes?.['start of speech offset (ms)'] === 'number')
    .map(c => ({ start: c.attributes['start of speech offset (ms)'], end: Number(c.attributes['end of speech offset (ms)']) }))
    .sort((a, b) => a.start - b.start);

  const voices: Voice[] = children
    .filter(c => typeof c?.attributes?.['audio duration (ms)'] === 'number' && c.attributes['audio duration (ms)'] >= BLIP_MS)
    .map(c => {
      const produced = time(c.startTime) + (Number(c.attributes['time to first audio (ms)']) || 0);
      return { produced, start: produced, duration: c.attributes['audio duration (ms)'], agent: speaker(String(c.attributes.agent ?? '')) };
    })
    .filter(v => !isNaN(v.produced))
    .sort((a, b) => a.produced - b.produced);
  // One voice at a time: a reply ready while another agent is still talking waits for it.
  voices.forEach((voice, i) => {
    if (i > 0) voice.start = Math.max(voice.produced, voices[i - 1].start + voices[i - 1].duration);
  });

  const lines = (info.messages as any[])
    .map(message => ({
      role: String(message?.role ?? ''),
      at: time(message?.eventTime),
      chunks: (Array.isArray(message?.chunks) ? message.chunks : []).filter(
        (chunk: any) => typeof chunk?.transcript === 'string' && chunk.transcript.trim() !== '',
      ),
    }))
    .filter(line => line.chunks.length > 0 && !isNaN(line.at))
    .sort((a, b) => a.at - b.at);

  return { start, vads, voices, lines };
}

/** Gives each agent line the stretch of voice it was said in: its own agent's next one. */
function voicesForLines(turn: Turn): Map<Voice, Line[]> {
  const byVoice = new Map<Voice, Line[]>();
  const taken = new Set<Voice>();
  for (const line of turn.lines) {
    if (line.role.toLowerCase() === 'user') continue;
    const own = turn.voices.filter(v => v.agent === speaker(line.role));
    // Without names to go on, the voices are taken in order.
    const pool = own.length > 0 ? own : turn.voices;
    // More lines than voices ("Checking those details." and then the answer, in
    // one go) share the last one.
    const voice = pool.find(v => !taken.has(v)) ?? pool[pool.length - 1];
    if (!voice) continue;
    taken.add(voice);
    byVoice.set(voice, [...(byVoice.get(voice) ?? []), line]);
  }
  return byVoice;
}

export function readSpeechTiming(data: unknown): SpeechTiming | null {
  const found: Record<string, any>[] = [];
  collectTurns(data, found);
  const turns = found.map(readTurn).filter((t): t is Turn => t !== null);
  if (turns.length === 0) return null;

  // Whether this session stamps agent lines where they start or where they end,
  // judged from the voices that carry a single line.
  const assigned = turns.map(voicesForLines);
  let startVotes = 0;
  let endVotes = 0;
  assigned.forEach(byVoice => byVoice.forEach((lines, voice) => {
    if (lines.length !== 1) return;
    const toStart = Math.abs(lines[0].at - voice.produced);
    const toEnd = Math.abs(lines[0].at - (voice.produced + voice.duration));
    if (toStart < toEnd) startVotes++;
    else endVotes++;
  }));
  const stampedAtStart = startVotes > endVotes;

  // The speech offsets count from the start of the call, not of their own turn.
  const callStart = Math.min(...turns.map(t => t.start));
  const starts = new Map<object, number>();
  const speech: CallSpeech = { user: [], agent: [] };
  const mark = (chunks: object[], at: number) => chunks.forEach(chunk => starts.set(chunk, at));

  turns.forEach((turn, t) => {
    turn.vads.forEach(vad => {
      if (!isNaN(vad.end)) speech.user.push([callStart + vad.start, callStart + vad.end]);
    });
    const said = turn.lines.find(line => line.role.toLowerCase() === 'user');
    if (said && turn.vads.length > 0) mark(said.chunks, callStart + turn.vads[0].start);
    turn.voices.forEach(voice => speech.agent.push([voice.start, voice.start + voice.duration]));

    assigned[t].forEach((lines, voice) => {
      // A voice that only began well after its line was stamped belongs to something else.
      if (voice.produced > lines[0].at + 1000) return;
      let used = 0;
      lines.forEach((line, i) => {
        let start = voice.start;
        if (i > 0 && stampedAtStart) {
          // Each later line starts at its stamp, as late as the voice was held back.
          start = Math.max(voice.start, line.at + (voice.start - voice.produced));
        } else if (i > 0) {
          // Each line ends at its stamp, so it starts however much of the voice is left before it.
          start = Math.max(lines[i - 1].at, line.at - (voice.duration - used));
        }
        used += Math.max(0, line.at - start);
        mark(line.chunks, start);
      });
    });
  });

  if (speech.user.length === 0 && speech.agent.length === 0) return null;
  return { starts, speech };
}
