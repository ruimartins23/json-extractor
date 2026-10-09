import { useState } from 'react';
import { Sparkles } from 'lucide-react';

// Bump this key when a new announcement should re-appear for everyone.
const STORAGE_KEY = 'ai-json-organizer:announcement:audio-jumps-v1';

export function Announcement() {
  const [visible, setVisible] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) !== 'dismissed';
    } catch {
      return true;
    }
  });

  if (!visible) return null;

  const dismissForever = () => {
    try {
      localStorage.setItem(STORAGE_KEY, 'dismissed');
    } catch {
      // ignore storage failures (private mode, etc.)
    }
    setVisible(false);
  };

  return (
    <div className="announcement glass animate-fade-in">
      <div className="announcement-icon">
        <Sparkles />
      </div>
      <div className="announcement-body">
        <h3 className="announcement-title">Quick update</h3>
        <p>Timestamps on the timeline now work with your audio:</p>
        <ul>
          <li>
            Click a timestamp to move the audio to where that line starts being said. The page goes up to
            the player, and Space plays from there. The timestamp itself still shows when the line finished.
          </li>
          <li>
            The tool finds the call in your recording by matching who spoke when, so it works with downloaded
            and trimmed files too.
          </li>
          <li>
            If a jump is a little off, click the wave where the line really starts and press{' '}
            <strong>Line up here</strong>. Every timestamp moves with it.
          </li>
          <li>
            Fixed: some user lines had no timestamp or showed their text twice, and lines shown together in
            one row now have a space between them.
          </li>
        </ul>
        <div className="announcement-actions">
          <button className="btn-secondary" onClick={dismissForever}>
            Never show again
          </button>
        </div>
      </div>
    </div>
  );
}
