import { useState } from 'react';
import { AlertTriangle, Sparkles } from 'lucide-react';

// Bump this key when a new announcement should re-appear for everyone.
const STORAGE_KEY = 'ai-json-organizer:announcement:listening-v1';

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
        <p>New: easier listening on the audio.</p>
        <ul>
          <li>
            <strong>Transcript beside the audio.</strong> With the JSON loaded, the transcript shows under the
            wave, next to your markers. Click a line to go there. The line being said lights up as it plays.
          </li>
          <li>
            <strong>Pause stays in place.</strong> Pausing now leaves the cursor where you stopped, so you can
            read the time of a delay. Untick "Pause stays in place" to have it go back to where play began.
          </li>
          <li>
            <strong>Space works anywhere.</strong> Press Space to play and pause from any part of the page.
          </li>
          <li>
            <strong>Zoom the wave.</strong> Hold Ctrl (⌘ on a Mac) and scroll over the wave, or use the zoom
            buttons, up to 8x. It zooms where the mouse is pointing.
          </li>
          <li>
            Fixed: words stuck together in the transcript ("I cancertainly help") when a line came in pieces.
          </li>
          <li>
            In case you missed it: right-click the wave to add a marker, each turn shows the silence before its
            reply, and a CN-Timing card suggests a rating from those silences.
          </li>
        </ul>
        <p className="announcement-warning">
          <AlertTriangle />
          <strong>The silence calculator can make mistakes. Please double-check before rating.</strong>
        </p>
        <div className="announcement-actions">
          <button className="btn-secondary" onClick={dismissForever}>
            Never show again
          </button>
        </div>
      </div>
    </div>
  );
}
