import type { CallSpeech } from './speechTiming';

/** The loaded recording: its length in seconds and when it started, in ms since the epoch. */
export interface AudioInfo {
  duration: number;
  startedAt: number;
  /** Where in it there is sound, to find the call's speech in it. */
  activity?: SoundActivity;
}

/** Where a recording has sound, in short frames. */
export interface SoundActivity {
  /** Seconds per frame. */
  frame: number;
  /** 1 for each frame with sound in it, 0 for quiet. */
  loud: Uint8Array;
  /** Running total of "sound in this frame" (1 or 0) minus the average, from frame 0. */
  prefix: Float64Array;
}

/**
 * The session on the clock, in ms since the epoch. `zero` is the moment the
 * timeline's +00:00 stands for (its first event); `start` and `end` bound the
 * whole call, the span the Duration in the header measures.
 */
export interface SessionClock {
  zero: number;
  start: number;
  end: number;
}

/**
 * Where the session sits inside the recording. `seconds` is how far into the
 * recording the timeline's +00:00 happens, negative when recording began after
 * the session had already started.
 */
export interface SessionOffset {
  seconds: number;
  /**
   * The same for the user's own voice, which the microphone picks up before the
   * call does, while the agent's arrives after its trip back. Defaults to `seconds`.
   */
  userSeconds?: number;
  /**
   * "speech": who spoke when in the session, found in the recording's sound.
   * "clock": from when the recording started or stopped. "length": the fallback.
   * "manual": a rater lined a timestamp up with the audio by hand.
   */
  method: 'speech' | 'clock' | 'length' | 'manual';
  /** For "manual": the timestamp it was lined up on. */
  linedUpOn?: string;
  /** For "manual": seconds it moved every jump compared with the automatic estimate. */
  correction?: number;
  /**
   * The session says who spoke when, but none of it lines up with this
   * recording's sound: most likely a recording of a different call.
   */
  unmatched?: boolean;
}

const FRAME = 0.02;

/** Marks each 20 ms of a recording as sound or quiet, mixing all its channels. */
export function soundActivity(channels: Float32Array[], sampleRate: number): SoundActivity {
  const size = Math.max(1, Math.round(sampleRate * FRAME));
  const frames = channels.length > 0 ? Math.floor(channels[0].length / size) : 0;
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (const data of channels) {
      for (let i = f * size, end = i + size; i < end; i++) sum += data[i] * data[i];
    }
    energy[f] = Math.sqrt(sum / (size * channels.length));
  }
  // Sound is well above the quietest fifth of the recording, and never mere hiss.
  const sorted = Float32Array.from(energy).sort();
  const threshold = Math.max((sorted[Math.floor(frames * 0.2)] ?? 0) * 4, 0.009);
  const loud = new Uint8Array(frames);
  let count = 0;
  for (let f = 0; f < frames; f++) {
    loud[f] = energy[f] > threshold ? 1 : 0;
    count += loud[f];
  }
  const mean = frames > 0 ? count / frames : 0;
  const prefix = new Float64Array(frames + 1);
  for (let f = 0; f < frames; f++) prefix[f + 1] = prefix[f] + loud[f] - mean;
  return { frame: FRAME, loud, prefix };
}

/** Stretches of speech, in seconds from the timeline's +00:00. */
type Stretch = [number, number];

/** How much more sound than usual the recording has where the stretches would fall. */
function overlap(activity: SoundActivity, stretches: Stretch[], lead: number): number {
  const last = activity.prefix.length - 1;
  const at = (seconds: number) => Math.min(last, Math.max(0, Math.round((seconds + lead) / activity.frame)));
  let score = 0;
  for (const [from, to] of stretches) score += activity.prefix[at(to)] - activity.prefix[at(from)];
  return score;
}

/** How sharply speech begins at each of these moments: sound just after, quiet just before. */
function onsets(activity: SoundActivity, starts: number[], lead: number): number {
  const edge = 0.4;
  return starts.reduce(
    (score, start) =>
      score + overlap(activity, [[start, start + edge]], lead) - overlap(activity, [[start - edge, start]], lead),
    0,
  );
}

/**
 * The lead between `from` and `to` that scores best, and the best score of any
 * other peak: anything past where the best one has fallen to half its height.
 */
function bestLead(activity: SoundActivity, from: number, to: number, score: (lead: number) => number) {
  const steps = Math.max(0, Math.floor((to - from) / activity.frame)) + 1;
  const scores = new Float64Array(steps);
  let best = 0;
  for (let i = 0; i < steps; i++) {
    scores[i] = score(from + i * activity.frame);
    if (scores[i] > scores[best]) best = i;
  }
  let left = best;
  while (left > 0 && scores[left] >= scores[best] / 2) left--;
  let right = best;
  while (right < steps - 1 && scores[right] >= scores[best] / 2) right++;
  const near = Math.round(1 / activity.frame);
  let runnerUp = -Infinity;
  for (let i = 0; i < steps; i++) {
    if ((i < left || i > right) && Math.abs(i - best) > near && scores[i] > runnerUp) runnerUp = scores[i];
  }
  // Never falling to half anywhere means no peak stands out at all.
  if (left === 0 && right === steps - 1 && scores[0] >= scores[best] / 2 && scores[steps - 1] >= scores[best] / 2) runnerUp = scores[best];
  return { lead: from + best * activity.frame, score: scores[best], runnerUp };
}

/**
 * Finds the call inside the recording from the sound alone: the session's trace
 * says who was speaking when, and only one position puts all of that on the
 * recording's sound. Works whatever the file's date or length, trimmed or not.
 */
function alignBySpeech(activity: SoundActivity, duration: number, session: SessionClock, speech: CallSpeech): SessionOffset | null {
  const toStretch = ([from, to]: [number, number]): Stretch => [(from - session.zero) / 1000, (to - session.zero) / 1000];
  const agent = speech.agent.map(toStretch);
  const user = speech.user.map(toStretch);
  if (agent.length < 3) return null;

  // What pins the call down is where each stretch of agent voice begins: speech
  // starting out of quiet. Whole stretches of speech line up almost as well one
  // turn over, so they cannot tell the right position from its neighbours.
  const agentStarts = agent.map(([from]) => from);
  const first = Math.min(...agentStarts);
  const last = Math.max(...agent.map(([, to]) => to));
  // Any position that leaves some of the call inside the recording.
  const fit = bestLead(activity, -last, duration - first, lead => onsets(activity, agentStarts, lead));
  // A clear winner, or nothing: a guess would send every jump to the wrong place.
  if (fit.score <= 0 || (fit.runnerUp > 0 && fit.score < fit.runnerUp * 1.5)) return null;
  const seconds = fit.lead;

  // The user's voice is in the recording up to a few seconds sooner than the
  // call heard it: the agent's reply has to travel back before it is recorded.
  // Their logged stretches run on past the end of what they said, so they are
  // placed by where each one begins.
  const starts = user.map(([from]) => from);
  const userFit = starts.length > 0 ? bestLead(activity, seconds - 3, seconds + 0.5, lead => onsets(activity, starts, lead)) : null;
  const userSeconds = userFit && userFit.score > onsets(activity, starts, seconds) ? userFit.lead : seconds;
  return { seconds, userSeconds, method: 'speech' };
}

/**
 * Lines a recording up with the session so a timeline timestamp can be found in it.
 *
 * Best is the call's own speech found in the recording's sound (see alignBySpeech).
 * Without that, the recording's own start time: it does not matter how long the
 * rater waited before pressing Stop. It is trusted only when the recording
 * actually overlaps the session, because a file that was copied or saved again
 * later carries a date that has nothing to do with the call.
 *
 * Otherwise it falls back to the difference in length, which assumes Stop was
 * pressed as the call ended, so the recording and the session end together.
 */
export function alignAudio(audio: AudioInfo, session: SessionClock, speech?: CallSpeech): SessionOffset {
  const canMatch = !!speech && !!audio.activity && speech.agent.length >= 3;
  const bySpeech = canMatch ? alignBySpeech(audio.activity!, audio.duration, session, speech!) : null;
  if (bySpeech) return bySpeech;

  const recordingEndMs = audio.startedAt + audio.duration * 1000;
  const fallback: SessionOffset =
    audio.startedAt < session.end && recordingEndMs > session.start
      ? { seconds: (session.zero - audio.startedAt) / 1000, method: 'clock' }
      : { seconds: audio.duration - (session.end - session.zero) / 1000, method: 'length' };
  // The speech was there to match and did not: say so rather than trust a guess.
  return canMatch ? { ...fallback, unmatched: true } : fallback;
}
