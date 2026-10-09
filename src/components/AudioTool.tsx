import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { AudioLines, ChevronDown, Play, Pause, Scissors, RotateCcw, Crosshair, Undo2 } from 'lucide-react';
import { decodeAudioFile, encodeAudio, waveformPeaks, formatClock } from '../utils/audio';
import type { AudioFormat } from '../utils/audio';
import { recordingStartOf } from '../utils/recordingStore';
import { soundActivity } from '../utils/audioSync';
import type { AudioInfo, SessionOffset } from '../utils/audioSync';

interface AudioToolProps {
  /** Recording attached on the upload page, loaded automatically when present. */
  initialFile?: File | null;
  format: AudioFormat;
  onFormatChange: (format: AudioFormat) => void;
  /** Hands up an encoder for the current file and trim, or null when no file is loaded. */
  onEncoderChange: (encode: ((onProgress?: (f: number) => void) => Promise<Blob>) | null) => void;
  /** A moment, in seconds, to put the play cursor on: a timestamp clicked on the
   *  timeline. The nonce lets the same moment be asked for twice in a row. */
  seekTo?: { seconds: number; nonce: number } | null;
  /** The loaded recording's length and start time, or null when nothing is loaded. */
  onAudioInfo?: (info: AudioInfo | null) => void;
  /** Where the session sits in the recording, to say how timestamps were lined up. */
  sessionOffset?: SessionOffset | null;
  /** Lines know when they start being said, so their timestamps jump there. */
  linesStartJumps?: boolean;
  /** The last timestamp clicked on the timeline, which the rater can line up by hand. */
  lineUpLabel?: string | null;
  /** That timestamp really happens at this many seconds into the recording. */
  onLineUp?: (seconds: number) => void;
  onUndoLineUp?: () => void;
}

const BUCKETS = 700;
type Drag = 'start' | 'end' | 'cursor' | null;

/** mm:ss.s — precise enough to trim on, still readable. */
function preciseClock(seconds: number): string {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}

export function AudioTool({ initialFile, format, onFormatChange, onEncoderChange, seekTo, onAudioInfo, sessionOffset, linesStartJumps, lineUpLabel, onLineUp, onUndoLineUp }: AudioToolProps) {
  const [open, setOpen] = useState(!!initialFile);
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [sourceName, setSourceName] = useState('');
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [rate, setRate] = useState(1);
  const [status, setStatus] = useState<'idle' | 'decoding'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState<number | null>(null);
  /** When the loaded recording started, in ms since the epoch. */
  const [startedAt, setStartedAt] = useState<number | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<AudioBufferSourceNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const dragRef = useRef<Drag>(null);
  const rateRef = useRef(1);
  /** Where playback was anchored: a position in the clip, and the clock time it
   *  started from. Rebased on a speed change so the playhead stays honest. */
  const anchorRef = useRef({ at: 0, clock: 0 });
  /** The last seek request already acted on, so a new file never replays an old one. */
  const handledSeekRef = useRef<number | null>(null);
  const [revealed, setRevealed] = useState(0);

  const peaks = useMemo(() => (buffer ? waveformPeaks(buffer, BUCKETS) : []), [buffer]);
  const duration = buffer?.duration ?? 0;
  const trimmed = Math.max(0, end - start);
  const pct = (t: number) => (duration ? (t / duration) * 100 : 0);

  const stopPlayback = useCallback(() => {
    nodeRef.current?.stop();
    nodeRef.current = null;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    setPlaying(false);
    setPlayhead(null);
  }, []);

  useEffect(() => stopPlayback, [stopPlayback]);

  const loadFile = useCallback(async (file: File) => {
    stopPlayback();
    setError(null);
    setStatus('decoding');
    try {
      const decoded = await decodeAudioFile(file);
      setBuffer(decoded);
      // A file's modified time is when recording stopped (the in-app recorder
      // creates it at Stop, and OBS last writes it at Stop), so the start is that
      // minus the length. A recovered take carries its real start instead.
      setStartedAt(recordingStartOf(file) ?? file.lastModified - decoded.duration * 1000);
      setSourceName(file.name);
      setStart(0);
      setEnd(decoded.duration);
      setCursor(0);
    } catch {
      setError('Could not read audio from that file. Try an .mp4, .mov, .m4a, .mp3 or .wav.');
      setBuffer(null);
    } finally {
      setStatus('idle');
    }
  }, [stopPlayback]);

  // A recording attached on the upload page lands here ready to trim.
  useEffect(() => {
    if (initialFile) loadFile(initialFile);
  }, [initialFile, loadFile]);

  // Where the recording has sound, so the session's speech can be found in it.
  const activity = useMemo(
    () => (buffer
      ? soundActivity(Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i)), buffer.sampleRate)
      : null),
    [buffer],
  );

  useEffect(() => {
    onAudioInfo?.(buffer && activity && startedAt !== null ? { duration: buffer.duration, startedAt, activity } : null);
  }, [buffer, activity, startedAt, onAudioInfo]);

  // A timestamp clicked on the timeline moves the cursor exactly as a click on
  // the wave does: playback stops, the cursor moves, the trim edges stay put.
  useEffect(() => {
    if (!seekTo || !buffer || handledSeekRef.current === seekTo.nonce) return;
    handledSeekRef.current = seekTo.nonce;
    stopPlayback();
    setCursor(Math.min(Math.max(seekTo.seconds, 0), buffer.duration));
    setOpen(true);
    setRevealed(seekTo.nonce);
  }, [seekTo, buffer, stopPlayback]);

  // Then the page goes to the wave, opened if it was collapsed, with focus on
  // it so Space plays from the new spot straight away.
  useEffect(() => {
    const track = trackRef.current;
    if (!revealed || !track) return;
    track.scrollIntoView({ block: 'center' });
    track.focus({ preventScroll: true });
  }, [revealed]);

  const playFrom = useCallback((from: number) => {
    if (!buffer) return;
    nodeRef.current?.stop();
    nodeRef.current = null;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);

    const begin = Math.min(Math.max(from, 0), Math.max(0, end - 0.05));
    const ctx = ctxRef.current ?? new AudioContext();
    ctxRef.current = ctx;
    // A context built outside a user gesture comes up suspended: its clock never
    // moves, so nothing is heard and the playhead sits still saying "Pause".
    if (ctx.state === 'suspended') void ctx.resume();
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);
    node.playbackRate.value = rateRef.current;
    node.onended = () => stopPlayback();
    // The length is in clip seconds, so a faster rate simply gets there sooner.
    node.start(0, begin, Math.max(0.05, end - begin));
    nodeRef.current = node;
    anchorRef.current = { at: begin, clock: ctx.currentTime };
    setPlaying(true);

    const tick = () => {
      const { at, clock } = anchorRef.current;
      setPlayhead(at + (ctx.currentTime - clock) * rateRef.current);
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();
  }, [buffer, end, stopPlayback]);

  /** Plays from the cursor to the end edge, restarting at the start when spent. */
  const playSelection = () => {
    if (playing) return stopPlayback();
    playFrom(cursor >= end - 0.05 ? start : cursor);
  };

  /** Changes speed without the playhead jumping: bank the position reached at
   *  the old rate, then start counting again at the new one. */
  const changeRate = (next: number) => {
    const ctx = ctxRef.current;
    const node = nodeRef.current;
    if (ctx && node) {
      const { at, clock } = anchorRef.current;
      anchorRef.current = { at: at + (ctx.currentTime - clock) * rateRef.current, clock: ctx.currentTime };
      node.playbackRate.value = next;
    }
    rateRef.current = next;
    setRate(next);
  };

  const resetTrim = () => {
    setStart(0);
    setEnd(duration);
    setCursor(0);
    stopPlayback();
  };

  // The last clicked timestamp really happens here: the playhead while playing, else the cursor.
  const lineUpHere = () => {
    const at = playhead ?? cursor;
    stopPlayback();
    setCursor(at);
    onLineUp?.(at);
  };

  const onKeys = (e: React.KeyboardEvent) => {
    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      playSelection();
    }
  };

  // Publish an encoder that always reflects the current file, trim and format,
  // so downloading can never hand back a stale clip.
  useEffect(() => {
    if (!buffer) return onEncoderChange(null);
    onEncoderChange((onProgress) => encodeAudio(format, buffer, start, end, onProgress));
  }, [buffer, start, end, format, onEncoderChange]);

  // ---- Dragging: each control owns its own pointer, so nothing is ambiguous ----
  const timeAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || !duration) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * duration;
  };

  /** Capture can throw if the pointer is already gone; never let that kill the drag. */
  const capture = (pointerId: number) => {
    try {
      trackRef.current?.setPointerCapture(pointerId);
    } catch {
      // Dragging still works through the track's own handlers.
    }
  };

  const beginDrag = (kind: Drag) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = kind;
    // Capture on the track, which owns the move/up handlers.
    capture(e.pointerId);
  };

  const onTrackMove = (e: React.PointerEvent) => {
    if (!dragRef.current || !buffer) return;
    const t = timeAt(e.clientX);
    if (dragRef.current === 'start') setStart(Math.min(t, end - 0.2));
    else if (dragRef.current === 'end') setEnd(Math.max(t, start + 0.2));
    else setCursor(t);
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  /** Clicking or dragging the wave moves the play cursor and nothing else. The
   *  two edges only move when their own handles are dragged. */
  const seekCursor = (e: React.PointerEvent) => {
    if (!buffer) return;
    setCursor(timeAt(e.clientX));
    if (playing) stopPlayback();
    dragRef.current = 'cursor';
    capture(e.pointerId);
  };

  const nudge = (which: 'start' | 'end', delta: number) => {
    if (which === 'start') setStart(s => Math.max(0, Math.min(s + delta, end - 0.2)));
    else setEnd(en => Math.min(duration, Math.max(en + delta, start + 0.2)));
  };

  // ---- Waveform (bars only; overlays are real elements) ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !buffer) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    // Painted, not styled, so the colours have to be read off the theme. They
    // are derived with relative colour syntax, which a custom property holds as
    // unevaluated text, so each one is resolved through a probe element first.
    const resolve = (token: string) => {
      const probe = document.createElement('span');
      probe.style.color = `var(${token})`;
      canvas.parentElement?.appendChild(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    };
    const waveColours = { lit: resolve('--wave-lit'), dim: resolve('--wave-dim') };

    const x0 = (start / buffer.duration) * w;
    const x1 = (end / buffer.duration) * w;
    const barW = w / peaks.length;
    peaks.forEach((peak, i) => {
      const x = i * barW;
      const inRange = x >= x0 && x <= x1;
      const barH = Math.max(1, peak * (h - 12));
      g.fillStyle = inRange ? waveColours.lit : waveColours.dim;
      g.fillRect(x, (h - barH) / 2, Math.max(0.8, barW - 0.4), barH);
    });
    // `open` matters: the canvas is unmounted while collapsed, so re-expanding needs a redraw.
  }, [peaks, buffer, start, end, open]);

  return (
    <div className={`audio-panel glass ${open ? '' : 'collapsed'}`}>
      <button className="reference-header" onClick={() => setOpen(o => !o)}>
        <AudioLines className="reference-icon" />
        <div className="reference-title-group">
          <h3 className="panel-title">Audio</h3>
          <span className="reference-subtitle">
            {buffer
              ? `${sourceName}, ${formatClock(trimmed)} selected`
              : 'Trim the recording and save it as .m4a or .mp3'}
          </span>
        </div>
        <ChevronDown className={`reference-chevron ${open ? 'open' : ''}`} />
      </button>

      {open && (
        <div className="reference-body animate-fade-in">
          <div className="audio-actions">
            <button className="btn-secondary" onClick={() => inputRef.current?.click()}>
              {buffer ? 'Choose a different file' : 'Select video or audio file'}
            </button>
            <input
              ref={inputRef}
              type="file"
              accept="video/*,audio/*,.mp4,.mov,.m4v,.webm,.m4a,.mp3,.wav,.aac,.ogg"
              style={{ display: 'none' }}
              onChange={e => e.target.files?.[0] && loadFile(e.target.files[0])}
            />
            <div className="audio-format">
              <span className="export-option-label">Format:</span>
              <div className="segmented-control compact">
                {(['m4a', 'mp3'] as const).map(f => (
                  <button key={f} className={`segment-btn ${format === f ? 'active' : ''}`} onClick={() => onFormatChange(f)}>
                    .{f}
                  </button>
                ))}
              </div>
            </div>
            {status === 'decoding' && <span className="audio-note">Reading audio…</span>}
            {error && <span className="audio-error">{error}</span>}
          </div>


          {buffer && (
            <>
              <div className="audio-transport">
                <button className="btn-primary transport-play" onClick={playSelection}>
                  {playing ? <Pause className="btn-icon" /> : <Play className="btn-icon" />}
                  {playing ? 'Pause' : 'Play'}
                </button>
                <span className="transport-time">{preciseClock(playhead ?? cursor)}</span>
                <div className="segmented-control compact speed-control" title="Playback speed. The saved file is always normal speed.">
                  {[1, 1.5, 2].map(r => (
                    <button
                      key={r}
                      className={`segment-btn ${rate === r ? 'active' : ''}`}
                      onClick={() => changeRate(r)}
                    >
                      {r}x
                    </button>
                  ))}
                </div>
                <span className="transport-keep">
                  <Scissors className="btn-icon-sm" />
                  Keeping <strong>{formatClock(trimmed)}</strong> of {formatClock(duration)}
                </span>
                <button className="btn-secondary" onClick={resetTrim}>
                  <RotateCcw className="btn-icon-sm" /> Reset
                </button>
              </div>

              <div
                className="audio-track"
                ref={trackRef}
                tabIndex={0}
                role="group"
                aria-label="Audio wave. Space plays and pauses from the cursor."
                onKeyDown={onKeys}
                onPointerMove={onTrackMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              >
                <canvas ref={canvasRef} className="audio-wave" onPointerDown={seekCursor} />

                {/* Everything outside the selection is dimmed */}
                <div className="audio-dim" style={{ left: 0, width: `${pct(start)}%` }} />
                <div className="audio-dim" style={{ left: `${pct(end)}%`, right: 0 }} />

                <div className="audio-cursor" style={{ left: `${pct(playhead ?? cursor)}%` }}>
                  <span className="audio-cursor-grip" />
                </div>

                <div
                  className="audio-handle start"
                  style={{ left: `${pct(start)}%` }}
                  onPointerDown={beginDrag('start')}
                  title="Drag to move the start"
                >
                  <span className="audio-handle-bar" />
                </div>
                <div
                  className="audio-handle end"
                  style={{ left: `${pct(end)}%` }}
                  onPointerDown={beginDrag('end')}
                  title="Drag to move the end"
                >
                  <span className="audio-handle-bar" />
                </div>
              </div>

              <p className="trim-help">
                Click anywhere on the wave to listen from there. Drag the two blue edges to set what
                you keep: the lit part is what gets saved. Space plays and pauses.
              </p>

              {sessionOffset && (
                <p className="trim-help audio-sync-note">
                  Timestamps on the timeline jump to the matching moment here.{' '}
                  {sessionOffset.seconds >= 0 ? (
                    <>The session starts <strong>{preciseClock(sessionOffset.seconds)}</strong> into this recording</>
                  ) : (
                    <>This recording starts <strong>{preciseClock(-sessionOffset.seconds)}</strong> after the session began</>
                  )}
                  {sessionOffset.method === 'speech' && ', found by matching who spoke when in the session to the sound in this recording.'}
                  {sessionOffset.method === 'clock' && ', worked out from when it was recorded.'}
                  {sessionOffset.method === 'length' &&
                    ". The file's date didn't match the call, so this is estimated from how much longer the recording is than the session."}
                  {sessionOffset.method === 'manual' && (
                    <>
                      , lined up by hand on <strong>{sessionOffset.linedUpOn}</strong>: every jump is{' '}
                      {Math.abs(sessionOffset.correction ?? 0).toFixed(1)} s{' '}
                      {(sessionOffset.correction ?? 0) >= 0 ? 'later' : 'earlier'} than worked out.
                    </>
                  )}
                  {linesStartJumps && ' Each line jumps to where it starts being said: its timestamp marks when it finished.'}
                </p>
              )}

              {sessionOffset && (lineUpLabel || sessionOffset.method === 'manual') && (
                <div className="audio-lineup">
                  {lineUpLabel && (
                    <button className="btn-secondary" onClick={lineUpHere}>
                      <Crosshair className="btn-icon-sm" /> Line up {lineUpLabel} here
                    </button>
                  )}
                  {sessionOffset.method === 'manual' && (
                    <button className="btn-secondary" onClick={onUndoLineUp}>
                      <Undo2 className="btn-icon-sm" /> Undo line-up
                    </button>
                  )}
                  {lineUpLabel && (
                    <span className="audio-lineup-hint">
                      Line not here? Click the wave where it really starts, or press this while it plays.
                    </span>
                  )}
                </div>
              )}

              <div className="trim-rows">
                <div className="trim-side">
                  <span className="field-label">Starts at</span>
                  <span className="trim-time">{preciseClock(start)}</span>
                  <button className="btn-secondary" onClick={() => nudge('start', -1)} title="One second earlier">−1s</button>
                  <button className="btn-secondary" onClick={() => nudge('start', 1)} title="One second later">+1s</button>
                </div>
                <div className="trim-side">
                  <span className="field-label">Ends at</span>
                  <span className="trim-time">{preciseClock(end)}</span>
                  <button className="btn-secondary" onClick={() => nudge('end', -1)} title="One second earlier">−1s</button>
                  <button className="btn-secondary" onClick={() => nudge('end', 1)} title="One second later">+1s</button>
                </div>
              </div>

              <p className="audio-note">When you download the files, it applies the cut.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
