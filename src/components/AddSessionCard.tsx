import { useEffect, useRef, useState } from 'react';
import { ClipboardPaste, FileJson, Upload } from 'lucide-react';
import { isMac } from '../utils/platform';

interface AddSessionCardProps {
  /** How the JSON will be read, as chosen on the first page. */
  readAs: string;
  /** Reads the parsed JSON; returns a reason it was not opened, or null when it was. */
  onAddJson: (json: unknown) => string | null;
  onReset: () => void;
}

const shortcutHint = isMac ? '⌘ + Enter' : 'Ctrl + Enter';

/**
 * Stands in for the session header while only a recording is loaded. The JSON
 * can be added here at any point; the page then becomes the full session view,
 * with the recording, its trim and the export fields left as they are.
 */
export function AddSessionCard({ readAs, onAddJson, onReset }: AddSessionCardProps) {
  const [pasted, setPasted] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const readText = (text: string) => {
    try {
      setError(onAddJson(JSON.parse(text)));
    } catch (err) {
      setError(`That is not valid JSON. ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const readFile = (file: File) => {
    if (!/\.(txt|json)$/i.test(file.name)) {
      setError(
        file.type.startsWith('audio/') || file.type.startsWith('video/')
          ? 'That is a recording. To use a different one, choose it in the Audio panel below.'
          : 'Please add a .txt or .json file.',
      );
      return;
    }
    file.text().then(readText, () => setError('That file could not be read.'));
  };

  // Like the first page, a JSON file can be dropped anywhere.
  const readFileRef = useRef(readFile);
  readFileRef.current = readFile;
  useEffect(() => {
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      depth++;
      setDragging(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const over = (e: DragEvent) => e.preventDefault();
    const drop = (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const file = e.dataTransfer?.files?.[0];
      if (file) readFileRef.current(file);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);

  const submitPasted = () => {
    if (pasted.trim()) readText(pasted);
  };

  return (
    <div className="session-header add-session glass">
      <div className="session-header-top">
        <h2 className="timeline-title">
          <FileJson className="timeline-title-icon" />
          Add the session JSON
        </h2>
        <button onClick={onReset} className="btn-secondary header-reset">
          Start over
        </button>
      </div>

      <p className="add-session-hint">
        The recording is loaded below, so you can trim and download it now. Add the JSON whenever
        you have it and the timeline opens here, with the recording kept just as it is. It will be
        read as <strong>{readAs}</strong>, as chosen on the first page.
      </p>

      <div className="add-session-pick">
        <button className="btn-primary" onClick={() => inputRef.current?.click()}>
          <Upload className="btn-icon" />
          Select file
        </button>
        <span className="add-session-or">or drop it anywhere on this page, or paste it below</span>
        <input
          ref={inputRef}
          type="file"
          accept=".txt,.json"
          style={{ display: 'none' }}
          onChange={e => {
            const file = e.target.files?.[0];
            if (file) readFile(file);
            e.target.value = '';
          }}
        />
      </div>

      <textarea
        className="paste-textarea add-session-paste"
        placeholder="Paste your raw JSON content here..."
        value={pasted}
        onChange={e => setPasted(e.target.value)}
        onKeyDown={e => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submitPasted();
        }}
      />
      <div className="paste-actions">
        <span className="paste-shortcut">{shortcutHint} to process</span>
        <button className="btn-secondary" onClick={submitPasted} disabled={!pasted.trim()}>
          <ClipboardPaste className="btn-icon" />
          Process pasted text
        </button>
      </div>

      {error && <div className="error-message add-session-error">{error}</div>}

      {dragging && (
        <div className="drop-overlay">
          <div className="drop-overlay-inner">
            <Upload className="drop-overlay-icon" />
            <span>Drop the JSON anywhere</span>
          </div>
        </div>
      )}
    </div>
  );
}
