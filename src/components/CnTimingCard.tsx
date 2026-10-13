import { AlertTriangle, Hourglass } from 'lucide-react';
import type { CnTimingSuggestion, TimingSilence } from '../utils/cnTiming';

interface CnTimingCardProps {
  suggestion: CnTimingSuggestion;
  /** Moves the audio cursor to a moment in the recording, in seconds. */
  onHear: (seconds: number) => void;
}

const clock = (seconds: number) => {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};

function whatHappened(s: TimingSilence): string {
  const where =
    s.kind === 'reply'
      ? `before ${s.speaker} replied`
      : s.kind === 'wait'
        ? `after "${s.after}"`
        : `after "${s.after}", until the user spoke up`;
  const said = s.explained ?? 'unexplained';
  return `${where} · ${said}`;
}

/**
 * The CN-Timing rating the silences point to, with the reason in words a rater
 * can check by ear, and a clear note that the rest of the rubric is theirs.
 */
export function CnTimingCard({ suggestion, onHear }: CnTimingCardProps) {
  const { score, reason, close, notable, replies, opening } = suggestion;

  return (
    <section className="cn-timing glass" aria-labelledby="cn-timing-title">
      <div className="cn-timing-head">
        <Hourglass className="reference-icon" />
        <div className="reference-title-group">
          <h3 className="panel-title" id="cn-timing-title">
            CN-Timing suggestion
            <span className="beta-tag">beta</span>
          </h3>
          <span className="reference-subtitle">
            From the silences in the recording, matched to who spoke when in the session
          </span>
        </div>
        <div className={`cn-timing-score score-${score}`} aria-label={`Suggested ${score} out of 5`}>
          <strong>{score}</strong>
          <span>/5</span>
        </div>
      </div>

      <p className="cn-timing-reason">
        According to the timing in this recording, CN-Timing would be <strong>{score}</strong>, because {reason}.
        {close && ' That silence is within 0.2 s of a line in the rubric, so listen to it to be sure.'}
      </p>

      {notable.length > 0 && (
        <>
          <h4 className="cn-timing-subtitle">Silences over 3 s from the agent</h4>
          <ul className="cn-timing-list">
            {notable.map(s => (
              <li key={s.from}>
                <button
                  type="button"
                  className="cn-timing-silence"
                  title="Click to hear it, from a second before"
                  onClick={() => onHear(Math.max(0, s.from - 1))}
                >
                  <span className="cn-timing-at">{clock(s.from)}</span>
                  <span className="cn-timing-length">{s.seconds.toFixed(1)} s</span>
                  <span className="cn-timing-what">{whatHappened(s)}</span>
                  <span className={`cn-timing-level score-${s.level}`} title={`On its own, this would rate ${s.level}`}>
                    {s.level}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {(replies.count > 0 || opening) && (
        <p className="cn-timing-stats">
          {replies.count > 0 && (
            <>
              The agent replied to the user {replies.count} {replies.count === 1 ? 'time' : 'times'}: typically after{' '}
              {replies.typical.toFixed(1)} s, at most {replies.longest.toFixed(1)} s.{' '}
            </>
          )}
          {opening && (
            <>
              The opening isn't counted: the {opening.seconds.toFixed(1)} s at {clock(opening.from)} before {opening.speaker}{' '}
              answered the user's first hello.{' '}
            </>
          )}
          Silences are as heard in the recording, delays on the line included.
        </p>
      )}

      <div className="cn-timing-warning" role="note">
        <AlertTriangle className="btn-icon-sm" />
        <p>
          <strong>Please double-check before you rate.</strong> I can only measure the timing: how long each silence
          lasts and whether the agent announced or thanked the caller for a wait. I can't judge the rest of the rubric,
          such as interruptions, talking over each other, cut-off speech, or whether a pause felt natural.
        </p>
      </div>
    </section>
  );
}
