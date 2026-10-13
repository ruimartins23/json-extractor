import { useState, useRef, useEffect, useCallback } from 'react';
import { Mic, Square, Circle, AlertTriangle } from 'lucide-react';
import { canRecord, startRecording, RecorderError } from '../utils/recorder';
import { clearStoredRecording, loadStoredRecording } from '../utils/recordingStore';
import type { StoredRecording } from '../utils/recordingStore';
import { isMac } from '../utils/platform';
import type { ActiveRecording, Levels } from '../utils/recorder';

interface AudioRecorderProps {
  /** Name for the captured file, minus the extension. */
  baseName: string;
  /** Handed the recording once it stops, ready to trim. */
  onRecorded: (file: File) => void;
  /** Hidden once a recording exists, since the steps have served their purpose. */
  showGuide?: boolean;
  /** Lets the page block anything that would discard a recording in progress. */
  onRecordingChange?: (recording: boolean) => void;
}

type State = 'idle' | 'starting' | 'recording' | 'saving';

const STEPS_KEY = 'ai-json-organizer:recorder-steps';

/** A channel that never moved is a channel that is not being captured. */
const SILENCE_GRACE_SECONDS = 8;

/** "4 minutes ago", near enough to recognise which take it is. */
function ago(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}

function megabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 0.1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function timer(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${(whole % 60).toString().padStart(2, '0')}`;
}

interface ChannelProps {
  label: string;
  level: number;
  gain: number;
  onGain: (value: number) => void;
  silent: boolean;
}

function Channel({ label, level, gain, onGain, silent }: ChannelProps) {
  return (
    <div className="channel">
      <div className="channel-head">
        <span className="meter-label">{label}</span>
        {silent && <span className="meter-warn">no sound yet</span>}
        <span className="channel-gain">{Math.round(gain * 100)}%</span>
      </div>
      <div className="meter-bar">
        <div
          className={`meter-fill ${level > 0.95 ? 'hot' : ''}`}
          style={{ width: `${Math.round(level * 100)}%` }}
        />
      </div>
      <input
        type="range"
        className="channel-slider"
        min={0}
        max={2}
        step={0.05}
        value={gain}
        aria-label={`${label} volume`}
        onChange={e => onGain(Number(e.target.value))}
        onDoubleClick={() => onGain(1)}
      />
    </div>
  );
}

export function AudioRecorder({
  baseName,
  onRecorded,
  showGuide = true,
  onRecordingChange,
}: AudioRecorderProps) {
  const [supported] = useState(canRecord);
  const [state, setState] = useState<State>('idle');
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState<Levels>({ mic: 0, tab: 0 });
  const [shared, setShared] = useState('');
  const [cleanMic, setCleanMic] = useState(true);
  // Kept between takes, so a setup that worked once does not need redoing.
  const [gains, setGains] = useState<Levels>({ mic: 1, tab: 1 });
  const [orphan, setOrphan] = useState<StoredRecording | null>(null);
  // Read once, then in the way. Hidden only if the user asks, and remembered.
  const [showSteps, setShowSteps] = useState(() => {
    try {
      return localStorage.getItem(STEPS_KEY) !== 'hidden';
    } catch {
      return true;
    }
  });

  const recordingRef = useRef<ActiveRecording | null>(null);
  const rafRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const peaksRef = useRef<Levels>({ mic: 0, tab: 0 });

  const finish = useCallback(async () => {
    const recording = recordingRef.current;
    if (!recording) return;
    recordingRef.current = null;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    setState('saving');
    try {
      onRecorded(await recording.stop());
      setError(null);
    } catch (err) {
      setError(err instanceof RecorderError ? err.message : 'That recording could not be saved.');
    } finally {
      setState('idle');
      setLevels({ mic: 0, tab: 0 });
    }
  }, [onRecorded]);

  // The external-stop callback outlives this render, so it reads through a ref.
  const finishRef = useRef(finish);
  finishRef.current = finish;

  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    recordingRef.current?.stop().catch(() => {});
  }, []);

  // A take left on disk means the page died before it was handed over.
  useEffect(() => {
    loadStoredRecording().then(setOrphan).catch(() => {});
  }, []);

  // Leaving mid-call would throw the recording away, and so would leaving while
  // the blob is still being assembled after the stop.
  useEffect(() => {
    onRecordingChange?.(state === 'recording' || state === 'saving');
    if (state !== 'recording') return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [state, onRecordingChange]);

  const begin = async () => {
    setError(null);
    setState('starting');
    peaksRef.current = { mic: 0, tab: 0 };
    try {
      const recording = await startRecording({ cleanMic, baseName, gains });
      // The new take has replaced whatever was stored.
      setOrphan(null);
      recordingRef.current = recording;
      setShared(recording.sharedLabel);
      recording.onExternalStop(() => finishRef.current());
      startedAtRef.current = Date.now();
      setElapsed(0);
      setState('recording');

      const tick = () => {
        const next = recording.levels();
        peaksRef.current = {
          mic: Math.max(peaksRef.current.mic, next.mic),
          tab: Math.max(peaksRef.current.tab, next.tab),
        };
        setLevels(next);
        setElapsed((Date.now() - startedAtRef.current) / 1000);
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch (err) {
      setError(err instanceof RecorderError ? err.message : 'Recording could not start.');
      setState('idle');
    }
  };

  if (!supported) {
    return (
      <p className="recorder-unsupported">
        Recording needs Chrome or Edge. In this browser, capture with OBS and add it with Use a file.
      </p>
    );
  }

  const toggleSteps = () => {
    const next = !showSteps;
    setShowSteps(next);
    try {
      localStorage.setItem(STEPS_KEY, next ? 'shown' : 'hidden');
    } catch {
      // Preference is a nicety, not worth failing over.
    }
  };

  const changeGain = (source: keyof Levels, value: number) => {
    setGains(current => ({ ...current, [source]: value }));
    recordingRef.current?.setGain(source, value);
  };

  const recording = state === 'recording';
  const quiet = (peak: number) => recording && elapsed > SILENCE_GRACE_SECONDS && peak < 0.01;

  return (
    <div className={`audio-recorder ${recording ? 'live' : ''}`}>
      {recording ? (
        <>
          <div className="recorder-status">
            <Circle className="rec-dot" />
            <span className="rec-timer">{timer(elapsed)}</span>
            <button className="btn-secondary" onClick={finish}>
              <Square className="btn-icon-sm" /> Stop recording
            </button>
            {shared && <span className="recorder-source">capturing {shared}</span>}
          </div>
          <div className="meter-row">
            <Channel
              label="You"
              level={levels.mic}
              gain={gains.mic}
              onGain={value => changeGain('mic', value)}
              silent={quiet(peaksRef.current.mic)}
            />
            <Channel
              label="Agent"
              level={levels.tab}
              gain={gains.tab}
              onGain={value => changeGain('tab', value)}
              silent={quiet(peaksRef.current.tab)}
            />
          </div>
        </>
      ) : (
        <>
          {orphan && (
            <div className="recorder-recovered">
              <span>
                A recording from <strong>{ago(orphan.savedAt)}</strong> was left unfinished
                ({megabytes(orphan.file.size)}). It is still here.
              </span>
              <button
                className="btn-secondary"
                onClick={() => {
                  onRecorded(orphan.file);
                  setOrphan(null);
                }}
              >
                Recover it
              </button>
              <button
                className="btn-secondary"
                onClick={() => {
                  void clearStoredRecording().catch(() => {});
                  setOrphan(null);
                }}
              >
                Discard
              </button>
            </div>
          )}
          <div className="recorder-status">
            <button className="btn-primary" onClick={begin} disabled={state !== 'idle'}>
              <Mic className="btn-icon-sm" />
              {state === 'starting' ? 'Waiting for the share…' : state === 'saving' ? 'Saving…' : 'Record the call'}
            </button>
            <label className="recorder-toggle">
              <input type="checkbox" checked={cleanMic} onChange={e => setCleanMic(e.target.checked)} />
              Clean up my mic
            </label>
            <button className="link-btn" onClick={toggleSteps}>
              {showSteps ? 'Hide the steps' : 'How does this work?'}
            </button>
            <span className="recorder-hint">
              Captures your microphone and the agent voice into one file, ready to trim with or
              without the JSON.
              {(gains.mic !== 1 || gains.tab !== 1) &&
                ` Volumes are set to ${Math.round(gains.mic * 100)}% you and ${Math.round(gains.tab * 100)}% agent.`}
            </span>
          </div>

          {showGuide && showSteps && (
          <div className="recorder-guide">
            <div className="recorder-guide-warn">
              <AlertTriangle className="btn-icon-sm" />
              {/* One span, or the flex container turns each text run into its own column. */}
              <span>
                When Chrome asks what to share, pick <strong>the agent tab</strong>, not this one.
                The agent voice is captured from that tab, so choosing anything else records only
                you.
              </span>
            </div>
            <ol className="recorder-steps">
              <li>Hit <strong>Record the call</strong>. Chrome opens its share dialog.</li>
              <li>
                Choose the <strong>Chrome Tab</strong> pane.{' '}
                {isMac
                  ? 'On a Mac, Entire Screen and Window carry no audio at all.'
                  : 'Entire Screen works too if you tick "share system audio", but the tab is cleaner. Window never carries audio.'}
              </li>
              <li>Select the tab the agent is talking in.</li>
              <li>
                Turn on <strong>Also share tab audio</strong>, bottom left. Without it there is no
                agent voice in the recording.
              </li>
              <li>
                Check both meters move once the call starts, then <strong>Stop</strong> when the
                call is over.
              </li>
            </ol>
            <p className="recorder-tip">
              Sounding muffled? Make sure your best microphone is the one selected in your system
              sound settings.
            </p>
          </div>
          )}
        </>
      )}
      {error && <span className="audio-error">{error}</span>}
    </div>
  );
}
