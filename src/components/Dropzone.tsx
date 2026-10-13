import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Upload, FileJson, ClipboardPaste, Settings2, ClipboardCheck, AudioLines, X } from 'lucide-react';
import type { EnvironmentMode, ParserConfig } from '../utils/parser';
import { SCENARIOS } from '../data/scenarios';
import { AudioRecorder } from './AudioRecorder';
import { isMac } from '../utils/platform';
import { formatClock } from '../utils/audio';

export interface ScenarioSelection {
  num: number;
  gender: 'male' | 'female';
}

interface DropzoneProps {
  onFileParsed: (
    data: unknown,
    mode: EnvironmentMode,
    config: ParserConfig,
    scenario: ScenarioSelection,
    media: File | null,
  ) => string | null;
  /** Opens the audio tools with only the recording, the JSON to be added later. */
  onRecordingOnly?: (
    media: File,
    mode: EnvironmentMode,
    config: ParserConfig,
    scenario: ScenarioSelection,
  ) => void;
}

const MEDIA_ACCEPT = 'video/*,audio/*,.mp4,.mov,.m4v,.webm,.m4a,.mp3,.wav,.aac,.ogg';

function isMediaFile(file: File): boolean {
  if (file.type.startsWith('video/') || file.type.startsWith('audio/')) return true;
  return /\.(mp4|mov|m4v|webm|mkv|m4a|mp3|wav|aac|ogg)$/i.test(file.name);
}

const shortcutHint = isMac ? '⌘ + Enter' : 'Ctrl + Enter';

function fileSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const MODES: { value: EnvironmentMode; label: string }[] = [
  { value: 'prod single agent', label: 'Prod Single Agent' },
  { value: 'prod multi agent', label: 'Prod Multi Agent' },
  { value: 'pre-prod', label: 'Pre-Prod' },
];

function KeywordChips({ options, value, onSelect }: {
  options: string[];
  value: string;
  onSelect: (keyword: string) => void;
}) {
  return (
    <div className="chip-row">
      {options.map(option => (
        <button
          key={option}
          onClick={() => onSelect(option)}
          className={`keyword-chip ${value === option ? 'active' : ''}`}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

export function Dropzone({ onFileParsed, onRecordingOnly }: DropzoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pastedText, setPastedText] = useState('');
  const [mode, setMode] = useState<EnvironmentMode>('prod single agent');
  const [functionKeyword, setFunctionKeyword] = useState('PythonFunctionTool');
  const [transferKeyword, setTransferKeyword] = useState('agentTransfer');
  const [endSessionKeyword, setEndSessionKeyword] = useState('EndSessionTool');
  const [scenarioNum, setScenarioNum] = useState(1);
  const [scenarioGender, setScenarioGender] = useState<'male' | 'female'>('male');
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [mediaLength, setMediaLength] = useState<number | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  // A URL to play the take back from, torn down with the file it belongs to.
  useEffect(() => {
    setMediaLength(null);
    if (!mediaFile) {
      setMediaUrl(null);
      return;
    }
    const url = URL.createObjectURL(mediaFile);
    setMediaUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [mediaFile]);

  // MediaRecorder webm carries no duration, so the player reports Infinity and
  // its scrubber is dead. Seeking past the end forces the real length out.
  const readLength = (event: React.SyntheticEvent<HTMLAudioElement>) => {
    const el = event.currentTarget;
    if (Number.isFinite(el.duration)) {
      setMediaLength(el.duration);
      return;
    }
    const settle = () => {
      el.ontimeupdate = null;
      el.currentTime = 0;
      if (Number.isFinite(el.duration)) setMediaLength(el.duration);
    };
    el.ontimeupdate = settle;
    el.currentTime = 1e101;
  };

  // Errors sit below the upload box, which can be off screen after a long scroll.
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [error]);

  // Scenario numbers depend on the environment (single vs multi) and the gender.
  const scenarioNumbers = useMemo(() => {
    const kind = mode === 'prod multi agent' ? 'multi' : 'single';
    return [...new Set(
      SCENARIOS.filter(s => s.agentType === kind && s.gender === scenarioGender).map(s => s.num)
    )].sort((a, b) => a - b);
  }, [mode, scenarioGender]);

  // Keep the selection valid when the environment or gender changes.
  const activeScenario = scenarioNumbers.includes(scenarioNum) ? scenarioNum : (scenarioNumbers[0] ?? 1);
  const scenarioTitle = (n: number) => {
    const kind = mode === 'prod multi agent' ? 'multi' : 'single';
    return SCENARIOS.find(s => s.agentType === kind && s.gender === scenarioGender && s.num === n)?.title || '';
  };

  const handleModeChange = (newMode: EnvironmentMode) => {
    setMode(newMode);
    setFunctionKeyword(newMode === 'pre-prod' ? 'toolCall' : 'PythonFunctionTool');
  };

  const processText = (text: string) => {
    // Loading the JSON leaves this page, which would destroy a recording still
    // in progress. That recording is a whole session and cannot be redone.
    if (isRecording) {
      setError('Stop the recording and let it save first. Loading the JSON now would throw the whole take away.');
      return;
    }
    try {
      const json = JSON.parse(text);
      const rejected = onFileParsed(
        json,
        mode,
        { functionKeyword, transferKeyword, endSessionKeyword },
        { num: activeScenario, gender: scenarioGender },
        mediaFile,
      );
      setError(rejected);
    } catch (err) {
      // Handled and shown to the user; no need to also throw a stack at the console.
      const reason = err instanceof Error ? err.message : String(err);
      setError(`That is not valid JSON. ${reason}`);
    }
  };

  const processFile = (file: File) => {
    // A dropped recording fills the optional media slot instead of failing as bad JSON.
    if (isMediaFile(file)) {
      setMediaFile(file);
      setError(null);
      return;
    }
    if (!file.name.endsWith('.txt') && !file.name.endsWith('.json')) {
      setError('Please upload a valid .txt or .json file.');
      return;
    }
    setError(null);

    const reader = new FileReader();
    reader.onload = (event) => {
      if (event.target?.result) {
        processText(event.target.result as string);
      }
    };
    reader.readAsText(file);
  };

  // Accept file drops anywhere on the page, not just inside the dropzone box.
  const processFileRef = useRef(processFile);
  processFileRef.current = processFile;

  useEffect(() => {
    let depth = 0;

    const onDragEnter = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) {
        depth++;
        setIsDragging(true);
      }
    };
    const onDragLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setIsDragging(false);
    };
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setIsDragging(false);
      const file = e.dataTransfer?.files?.[0];
      if (file) processFileRef.current(file);
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFile(e.target.files[0]);
    }
  };

  const handlePasteSubmit = () => {
    if (!pastedText.trim()) {
      setError('Please paste some content first.');
      return;
    }
    processText(pastedText);
  };

  return (
    <div className="dropzone-container">
      <div className="mode-selector glass animate-fade-in">
        <div className="mode-selector-header">
          <Settings2 className="btn-icon" style={{ color: 'var(--primary)' }} />
          <h3 className="panel-title">Select target environment</h3>
        </div>
        <p className="mode-selector-hint">
          Choose your environment to filter exactly which tool structures to look for.
        </p>
        <div className="segmented-control">
          {MODES.map(({ value, label }) => (
            <button
              key={value}
              className={`segment-btn ${mode === value ? 'active' : ''}`}
              onClick={() => handleModeChange(value)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="config-grid">
          <div className="config-field">
            <label className="field-label">Function tool keyword</label>
            <input
              type="text"
              value={functionKeyword}
              placeholder={mode === 'pre-prod' ? 'toolCall' : 'PythonFunctionTool'}
              onChange={(e) => setFunctionKeyword(e.target.value)}
              className="text-input"
            />
            <KeywordChips
              options={['toolCall', 'PythonFunctionTool']}
              value={functionKeyword}
              onSelect={setFunctionKeyword}
            />
          </div>
          {mode === 'prod multi agent' && (
            <div className="config-field">
              <label className="field-label">Transfer tool keyword</label>
              <input
                type="text"
                value={transferKeyword}
                placeholder="agentTransfer"
                onChange={(e) => setTransferKeyword(e.target.value)}
                className="text-input"
              />
            </div>
          )}
          {mode !== 'pre-prod' && (
            <div className="config-field">
              <label className="field-label">End session tool keyword</label>
              <input
                type="text"
                value={endSessionKeyword}
                placeholder="EndSessionTool"
                onChange={(e) => setEndSessionKeyword(e.target.value)}
                className="text-input"
              />
              <KeywordChips
                options={['toolCall', 'EndSessionTool']}
                value={endSessionKeyword}
                onSelect={setEndSessionKeyword}
              />
            </div>
          )}
        </div>

        <div className="scenario-select-row">
          <div className="mode-selector-header">
            <ClipboardCheck className="btn-icon" style={{ color: 'var(--primary)' }} />
            <h3 className="panel-title">
              Scenario
              <span className="beta-tag">beta</span>
            </h3>
          </div>
          <p className="mode-selector-hint">
            Pick the scenario you are rating so the scenario check can compare the expected calls.
          </p>
          <div className="config-grid">
            <div className="config-field">
              <label className="field-label">Scenario number</label>
              <select
                className="select-input"
                value={activeScenario}
                onChange={(e) => setScenarioNum(Number(e.target.value))}
              >
                {scenarioNumbers.map(n => (
                  <option key={n} value={n}>{n}. {scenarioTitle(n)}</option>
                ))}
              </select>
            </div>
            <div className="config-field">
              <label className="field-label">Gender</label>
              <div className="segmented-control">
                {(['male', 'female'] as const).map(g => (
                  <button
                    key={g}
                    className={`segment-btn ${scenarioGender === g ? 'active' : ''}`}
                    onClick={() => setScenarioGender(g)}
                  >
                    {g === 'male' ? 'Male' : 'Female'}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="upload-section animate-fade-in">
        <div className="glass record-card">
          <div className="media-slot">
            <div className="media-slot-icon">
              <AudioLines />
            </div>
            <div className="media-slot-body">
              <h3 className="panel-title media-slot-title">
                1. Recording <span className="media-slot-optional">optional</span>
              </h3>
              {mediaFile ? (
                <span className="media-slot-file">
                  {mediaFile.name}{' '}
                  <span className="media-slot-size">
                    {fileSize(mediaFile.size)}
                    {mediaLength !== null && ` · ${formatClock(mediaLength)}`}
                  </span>
                </span>
              ) : (
                <span className="media-slot-hint">
                  Do this first. The agent only hands over the JSON once the call is finished, so
                  start recording before you begin and paste the JSON below afterwards.
                </span>
              )}
            </div>
            <div className="media-slot-actions">
              <button className="btn-secondary" onClick={() => mediaInputRef.current?.click()}>
                {mediaFile ? 'Change file' : 'Use a file'}
              </button>
              {mediaFile && (
                <button className="icon-btn" title="Remove" onClick={() => setMediaFile(null)}>
                  <X />
                </button>
              )}
            </div>
          </div>

          {mediaUrl && (
            <div className="media-preview">
              <audio controls preload="metadata" src={mediaUrl} onLoadedMetadata={readLength} />
              <span className="media-preview-hint">
                Give it a listen before you carry on. You should hear yourself and the agent.
              </span>
            </div>
          )}

          {mediaFile && onRecordingOnly && (
            <div className="recording-only">
              <span className="recording-only-hint">
                No JSON yet? Trim and download the recording now, and add the JSON when you have it.
              </span>
              <button
                className="btn-secondary"
                disabled={isRecording}
                onClick={() =>
                  onRecordingOnly(
                    mediaFile,
                    mode,
                    { functionKeyword, transferKeyword, endSessionKeyword },
                    { num: activeScenario, gender: scenarioGender },
                  )
                }
              >
                <AudioLines className="btn-icon" />
                Continue with just the recording
              </button>
            </div>
          )}

          <AudioRecorder
            baseName="session-recording"
            onRecorded={setMediaFile}
            showGuide={!mediaFile}
            onRecordingChange={setIsRecording}
          />
          <input
            ref={mediaInputRef}
            type="file"
            accept={MEDIA_ACCEPT}
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) setMediaFile(file);
              e.target.value = '';
            }}
          />
        </div>

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isRecording}
          className={`glass dropzone-area ${isDragging ? 'dragging' : ''}`}
        >
          <div className="dropzone-icon-bg">
            <Upload className="dropzone-icon" />
          </div>
          <h3 className="dropzone-title">2. Upload the JSON</h3>
          <p className="dropzone-subtitle">
            Drag and drop your .txt or .json file anywhere on this page
          </p>

          <span className="btn-primary">
            <FileJson className="btn-icon" />
            Select File
          </span>
        </button>
        <input
          type="file"
          accept=".txt,.json"
          style={{ display: 'none' }}
          onChange={handleFileInput}
          ref={fileInputRef}
        />

        {error && (
          <div className="error-message animate-fade-in" ref={errorRef}>
            {error}
          </div>
        )}

        <div className="divider">
          <span>OR PASTE CONTENT</span>
        </div>

        <div className="glass paste-area">
          <textarea
            className="paste-textarea"
            placeholder="Paste your raw JSON content here..."
            value={pastedText}
            onChange={(e) => setPastedText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') handlePasteSubmit();
            }}
          />
          <div className="paste-actions">
            <span className="paste-shortcut">
              {isRecording ? 'Stop the recording first' : `${shortcutHint} to process`}
            </span>
            <button
              className="btn-primary"
              onClick={handlePasteSubmit}
              disabled={!pastedText.trim() || isRecording}
            >
              <ClipboardPaste className="btn-icon" />
              Process Pasted Text
            </button>
          </div>
        </div>

      </div>

      {isDragging && (
        <div className="drop-overlay">
          <div className="drop-overlay-inner">
            <Upload className="drop-overlay-icon" />
            <span>Drop it anywhere</span>
          </div>
        </div>
      )}
    </div>
  );
}
