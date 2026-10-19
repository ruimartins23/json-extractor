import { useState } from 'react';
import { AlertTriangle, Sparkles } from 'lucide-react';

// Bump this key when a new announcement should re-appear for everyone.
const STORAGE_KEY = 'ai-json-organizer:announcement:markers-v1';

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
        <p>New: markers on the audio.</p>
        <ul>
          <li>
            <strong>Add a marker.</strong> Right-click anywhere on the audio wave, type what happens there
            (for example a pilot tag) and press Enter.
          </li>
          <li>
            <strong>Find it again.</strong> Markers show on the wave in their own colour: hover one to read it,
            click it to go there. They are also listed under the wave, where you can edit or delete them.
          </li>
          <li>
            <strong>In the timeline.</strong> With the JSON loaded, each marker also appears in the timeline
            where it falls in the call. Click it to hear that moment.
          </li>
          <li>
            Markers are kept in your browser for that recording, so a reload doesn't lose them.
          </li>
          <li>
            In case you missed it: each turn shows the silence before its reply, and a CN-Timing card suggests a
            rating from those silences.
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
