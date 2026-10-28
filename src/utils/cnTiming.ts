import type { SoundActivity } from './audioSync';
import type { CallSpeech, SpokenLine } from './speechTiming';
import { quietBefore } from './silence';

/**
 * A suggested Conversation Naturalness — Timing (CN-Timing) rating, from the one
 * part of the rubric the data can measure: how long the agent left the caller in
 * silence, and whether it announced or acknowledged the wait. Interruptions, talk
 * over, cut-off speech and how natural a pause felt are left to the rater.
 */

/** A silence that bears on CN-Timing, as heard in the recording. */
export interface TimingSilence {
  /** Where the quiet ran in the recording, in seconds. */
  from: number;
  to: number;
  seconds: number;
  /**
   * "reply": before the agent answered the user. "wait": after the agent's own
   * line, such as a holding message during a lookup. "stall": the agent went quiet
   * after a holding message until the user spoke up.
   */
  kind: 'reply' | 'wait' | 'stall';
  /** Who broke the silence. */
  speaker: string;
  /** The agent line just before it, for a wait or a stall. */
  after?: string;
  /** Whether the agent set an expectation for it beforehand, or acknowledged it after. */
  explained: 'announced' | 'acknowledged' | null;
  /** What this silence alone would rate, 1 to 5. */
  level: number;
  /** When the line that broke the silence starts, in ms since the epoch: places it in a turn. */
  lineStart: number;
}

export interface CnTimingSuggestion {
  score: number;
  /** Why, worded to follow "because". */
  reason: string;
  /** The deciding silence is within 0.2 s of a line in the rubric, close enough to tip either way. */
  close: boolean;
  /** The silences over 3 s and any stalls, in the order they happened. */
  notable: TimingSilence[];
  /** How quickly the agent answered the user, across the call. */
  replies: { count: number; typical: number; longest: number };
  /** The silence before the agent greeted the user back, which the rating leaves out. */
  opening?: { seconds: number; speaker: string; from: number };
}

/** The agent saying it is working on something, so a wait after it is announced. */
const HOLDING =
  /\b(one|a|just a) (moment|minute|second|sec)\b|\bbear with me\b|\bhold on\b|\bplease hold\b|\bthis (might|may|could|will) take\b|\bgive me a (moment|minute|second|sec)\b|\blet me (check|look|pull|see|verify|review|confirm|find|get)\b|\b(checking|verifying|looking into|looking up|reviewing|pulling up|searching|processing|confirming)\b|\bi('ll| will) (check|look|pull|verify|review)\b|\bwhile i\b|\btransferr?ing you\b|\bconnecting you\b/i;
/** Wording that tells the caller to expect a wait outright. */
const EXPECT_WAIT = /\b(one|a|just a) (moment|minute|second|sec)\b|\bthis (might|may|could|will) take\b|\bbear with me\b|\bplease hold\b|\bhold on\b/i;
/** Thanking or apologising for a wait, on the agent's return. */
const ACKNOWLEDGED =
  /\bthank(s| you)( so much)? for (your )?(patience|waiting|holding|bearing with)|\bsorry (for|about) the (wait|delay)|\bsorry to keep you waiting|\bappreciate your patience|\bapologi[sz]e for the (wait|delay)/i;

/** The rubric's bands for a silence on its own: 1–3 s is natural, over 5 s is dead air, over 15 s abandoned. */
function levelFor(seconds: number): number {
  if (seconds <= 3) return 5;
  if (seconds <= 5) return 4;
  if (seconds <= 15) return 2;
  return 1;
}

const isUser = (role: string) => role.toLowerCase() === 'user';
const clock = (seconds: number) => {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};
const quote = (text: string) => `"${text.length > 48 ? `${text.slice(0, 45).trimEnd()}…` : text}"`;
const list = (items: string[]) =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

export function suggestCnTiming(
  lines: SpokenLine[],
  speech: CallSpeech,
  zeroMs: number,
  activity: SoundActivity,
  lead: { agent: number; user: number },
): CnTimingSuggestion | null {
  const stretches = [
    ...speech.user.map(span => ({ span, voice: 'user' as const })),
    ...speech.agent.map(span => ({ span, voice: 'agent' as const })),
  ].sort((a, b) => a.span[0] - b.span[0]);

  // The opening does not count: the user's first hello and the agent's greeting
  // back, up to when the user speaks again.
  const firstUser = lines.findIndex(line => isUser(line.role));
  const nextUser = lines.findIndex((line, i) => i > firstUser && isUser(line.role));
  const openingEnd = firstUser < 0 ? -1 : nextUser < 0 ? lines.length - 1 : nextUser - 1;
  let opening: CnTimingSuggestion['opening'];

  const silences: TimingSilence[] = [];
  lines.forEach((line, i) => {
    if (i === 0) return;
    const voice = isUser(line.role) ? 'user' : 'agent';
    // The speech before this line, wherever it came from, placed in the recording.
    const before = stretches.filter(({ span }) => span[0] < line.start - 10).at(-1);
    const previous = before && {
      from: (before.span[0] - zeroMs) / 1000 + lead[before.voice],
      to: (before.span[1] - zeroMs) / 1000 + lead[before.voice],
    };
    const quiet = quietBefore(activity, (line.start - zeroMs) / 1000 + lead[voice], previous);
    if (!quiet) return;
    const seconds = quiet.to - quiet.from;
    const prior = lines[i - 1];
    if (i <= openingEnd) {
      if (voice === 'agent' && i > firstUser && isUser(prior.role)) opening = { seconds, speaker: line.role, from: quiet.from };
      return;
    }

    if (voice === 'user') {
      // The agent said it was looking into something, then nothing came until the user spoke up.
      if (!isUser(prior.role) && HOLDING.test(prior.text) && !prior.text.trim().endsWith('?') && seconds >= 2) {
        const announcedLevel = Math.min(5, levelFor(seconds) + 1);
        silences.push({ ...quiet, seconds, kind: 'stall', speaker: 'user', after: prior.text, explained: 'announced', level: Math.min(3, announcedLevel), lineStart: line.start });
      }
      return;
    }

    let kind: TimingSilence['kind'];
    let explained: TimingSilence['explained'] = null;
    if (isUser(prior.role)) {
      kind = 'reply';
      const earlier = lines[i - 2];
      if (earlier && !isUser(earlier.role) && EXPECT_WAIT.test(earlier.text)) explained = 'announced';
    } else {
      // The agent asked something and is waiting on the user: not the agent's delay.
      if (prior.text.trim().endsWith('?')) return;
      kind = 'wait';
      if (HOLDING.test(prior.text)) explained = 'announced';
    }
    if (!explained && ACKNOWLEDGED.test(line.text.slice(0, 160))) explained = 'acknowledged';
    const length = levelFor(seconds);
    const level = explained ? Math.min(5, length + 1) : length;
    silences.push({ ...quiet, seconds, kind, speaker: line.role, after: kind === 'wait' ? prior.text : undefined, explained, level, lineStart: line.start });
  });

  const replies = silences.filter(s => s.kind === 'reply').map(s => s.seconds).sort((a, b) => a - b);
  if (replies.length === 0 && silences.length === 0 && !opening) return null;

  // The rating is the lowest any one silence earns, and several 3–5 s delays with
  // nothing said about them add up to a 3.
  const delays = silences.filter(s => s.kind !== 'stall' && !s.explained && s.seconds > 3 && s.seconds <= 5);
  let score = Math.min(5, ...silences.map(s => s.level));
  if (delays.length >= 2) score = Math.min(score, 3);

  const notable = silences.filter(s => s.kind === 'stall' || s.seconds > 3);
  const deciding = silences.filter(s => s.level === score).sort((a, b) => b.seconds - a.seconds);
  const describe = (s: TimingSilence) => {
    const quality = s.explained ? s.explained : 'unexplained';
    const where = s.kind === 'reply' ? `before ${s.speaker} replied` : `after ${quote(s.after ?? '')}`;
    return `${s.seconds.toFixed(1)} s of ${quality} silence ${where} at ${clock(s.from)}`;
  };
  const band = (s: TimingSilence) => {
    if (s.kind === 'stall') return 'the agent went quiet after its holding message until the user had to speak up';
    const verb = s.explained === 'announced' ? 'announced' : 'acknowledged';
    if (s.seconds > 15) return s.explained ? `over 15 s, even counting one level up because the agent ${verb} it` : 'over 15 s with nothing said about it';
    if (s.seconds > 5) return s.explained ? `over 5 s, counted one level up because the agent ${verb} it` : 'over 5 s with no expectation set before it and no acknowledgment after, which is dead air';
    return 'a 3–5 s delay with nothing said about it';
  };

  let reason: string;
  let decider: TimingSilence | undefined;
  if (score === 5) {
    reason = notable.length === 0
      ? `every reply and wait from the agent was 3 s or less${replies.length ? ` (the longest was ${replies[replies.length - 1].toFixed(1)} s)` : ''}`
      : `the only silences over 3 s (${list(notable.map(s => `${s.seconds.toFixed(1)} s at ${clock(s.from)}`))}) were ones the agent announced or acknowledged`;
  } else if (deciding.length > 0) {
    decider = deciding[0];
    const others = deciding.slice(1).sort((a, b) => a.from - b.from);
    const where = (s: TimingSilence) => (s.kind === 'reply' ? `before ${s.speaker} replied` : `after ${quote(s.after ?? '')}`);
    reason = `of ${describe(decider)}: ${band(decider)}`;
    if (others.length > 0) {
      reason += `. The same goes for ${list(others.map(s => `${s.seconds.toFixed(1)} s ${where(s)} at ${clock(s.from)}`))}`;
    }
    if (score === 4 && !silences.some(s => s !== decider && s.seconds > 3)) reason += '. Everything else was 3 s or less';
  } else {
    // Only the 3–5 s delays adding up brought it to 3.
    decider = [...delays].sort((a, b) => b.seconds - a.seconds)[0];
    reason = `there were ${delays.length} delays of 3–5 s with nothing said about them (${list(
      delays.map(s => `${s.seconds.toFixed(1)} s at ${clock(s.from)}`),
    )}), which add up across the call`;
  }

  const close = !!decider && [3, 5, 15].some(line => Math.abs(decider.seconds - line) < 0.2);
  return {
    score,
    reason,
    close,
    notable,
    replies: {
      count: replies.length,
      typical: replies.length ? replies[Math.floor(replies.length / 2)] : 0,
      longest: replies.length ? replies[replies.length - 1] : 0,
    },
    opening,
  };
}
