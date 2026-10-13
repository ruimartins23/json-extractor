import type { ParsedEvent } from './parser';
import type { SoundActivity } from './audioSync';
import type { CallSpeech } from './speechTiming';

/** The quiet before one side of a turn answered the other, as heard in the recording. */
export interface TurnSilence {
  /** Seconds of quiet. */
  seconds: number;
  /** Who answered: the agent's name, or "user". */
  replier: string;
  /** Where in the recording the quiet ran, in seconds. */
  from: number;
  to: number;
}

/** Sound this short on its own is a click or a breath, not speech. */
const CLICK = 0.1;
/** Gaps shorter than this are inside speech: between syllables and words. */
const BRIDGE = 0.3;
/** How far a reply's expected start may be from the sound that begins it. */
const SETTLE = 0.5;

const runsOf = new WeakMap<SoundActivity, [number, number][]>();

/**
 * The stretches of speech in a recording, in frames: sound with the short gaps
 * inside words and sentences joined up, and lone clicks dropped. Both the list of
 * silences and each turn's silence are the gaps between these, so they agree.
 */
function speechRuns(activity: SoundActivity): [number, number][] {
  const cached = runsOf.get(activity);
  if (cached) return cached;
  const { loud, frame } = activity;
  const bridge = Math.round(BRIDGE / frame);
  const click = Math.round(CLICK / frame);
  const runs: [number, number][] = [];
  for (let i = 0; i < loud.length; ) {
    if (!loud[i]) {
      i++;
      continue;
    }
    let end = i;
    while (end < loud.length && loud[end]) end++;
    const last = runs[runs.length - 1];
    if (last && i - last[1] < bridge) last[1] = end;
    else runs.push([i, end]);
    i = end;
  }
  const speech = runs.filter(([from, to]) => to - from >= click);
  runsOf.set(activity, speech);
  return speech;
}

/**
 * The quiet that ends where speech starts near `at` (seconds into the recording):
 * the stretch of speech starting closest to `at`, and the gap back to the one
 * before it. Null when no speech starts close enough to be sure, as when the two
 * talk over each other, so a wrong gap is never reported.
 */
export function quietBefore(
  activity: SoundActivity,
  at: number,
  previous?: { from: number; to: number },
): { from: number; to: number } | null {
  const runs = speechRuns(activity);
  const { frame } = activity;
  const target = at / frame;
  let reply = -1;
  for (let i = 0; i < runs.length; i++) {
    if (reply < 0 || Math.abs(runs[i][0] - target) < Math.abs(runs[reply][0] - target)) reply = i;
  }
  if (reply <= 0 || Math.abs(runs[reply][0] - target) > SETTLE / frame) return null;

  // When the session says when the other side was speaking, their speech is the
  // sound that starts inside that window: a cough, a click or noise after they
  // stopped is not them, and does not cut the silence short.
  let end = runs[reply - 1][1];
  if (previous) {
    const said = runs.slice(0, reply).filter(([start]) => start >= (previous.from - SETTLE) / frame && start <= previous.to / frame);
    if (said.length > 0) end = said[said.length - 1][1];
  }
  return { from: end * frame, to: runs[reply][0] * frame };
}

/**
 * Every quiet stretch of at least `min` seconds between two stretches of speech.
 * Without the session there is no telling who was waiting, so it is every pause
 * in the recording.
 */
export function findSilences(activity: SoundActivity, min = 1): { from: number; to: number }[] {
  const runs = speechRuns(activity);
  const silences: { from: number; to: number }[] = [];
  for (let i = 1; i < runs.length; i++) {
    const from = runs[i - 1][1] * activity.frame;
    const to = runs[i][0] * activity.frame;
    if (to - from >= min) silences.push({ from, to });
  }
  return silences;
}

/**
 * For each turn, the quiet between its first side finishing and the other side
 * starting: how long the agent took to reply to the user, or the user to the agent.
 *
 * Both sources are used for what each does best. The session says who replied,
 * roughly when, and when the other side was speaking before it; the recording
 * gives the exact moments, as the caller heard them with the delays on the line.
 * A turn whose reply has no known start is left out.
 *
 * `zeroMs` is the moment the timeline's +00:00 stands for; `lead` is where that
 * moment falls in the recording for each voice.
 */
export function turnSilences(
  events: ParsedEvent[],
  turnOf: number[],
  zeroMs: number,
  activity: SoundActivity,
  lead: { agent: number; user: number },
  speech?: CallSpeech,
): Map<number, TurnSilence> {
  const silences = new Map<number, TurnSilence>();
  const opener = new Map<number, 'user' | 'agent'>();
  const answered = new Set<number>();

  events.forEach((event, i) => {
    const turn = turnOf[i];
    if (event.type !== 'message' || turn === 0 || answered.has(turn)) return;
    const side = (event.messageRole ?? '').toLowerCase() === 'user' ? 'user' : 'agent';
    if (!opener.has(turn)) {
      opener.set(turn, side);
      return;
    }
    if (opener.get(turn) === side) return;

    // The first line from the other side is the reply.
    answered.add(turn);
    if (event.spokenAt === undefined) return;
    const at = (event.spokenAt - zeroMs) / 1000 + (side === 'user' ? lead.user : lead.agent);
    // The other side's last stretch of speech before the reply, placed in the recording.
    const other = side === 'user' ? 'agent' : 'user';
    const before = speech?.[other].filter(([from]) => from < event.spokenAt!).at(-1);
    const previous = before && {
      from: (before[0] - zeroMs) / 1000 + lead[other],
      to: (before[1] - zeroMs) / 1000 + lead[other],
    };
    const quiet = quietBefore(activity, at, previous);
    if (!quiet) return;
    silences.set(turn, {
      seconds: quiet.to - quiet.from,
      replier: side === 'user' ? 'user' : (event.messageRole ?? 'agent'),
      ...quiet,
    });
  });
  return silences;
}
