import { useState } from 'react';
import { AlertTriangle, Sparkles } from 'lucide-react';

// Bump this key when a new announcement should re-appear for everyone.
const STORAGE_KEY = 'ai-json-organizer:announcement:silences-v1';

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
        <p>The tool now measures the silences in your recording:</p>
        <ul>
          <li>
            <strong>Silence on every turn.</strong> With the recording and the JSON loaded, each turn in the
            timeline shows the silence before the reply, as heard in the recording, for example "6.0 s silence
            before Billing replied". Click it to hear it.
          </li>
          <li>
            <strong>CN-Timing suggestion.</strong> A new card under the Audio panel suggests a CN-Timing rating
            from the agent's silences, says why, and lists the silences behind it. The opening hello is not
            counted.
          </li>
          <li>
            <strong>Recording first, JSON later.</strong> Once you add a recording on the first page, click{' '}
            <strong>Continue with just the recording</strong> to trim it, download it and see its silences
            before you have the JSON. Add the JSON on the same page when it arrives.
          </li>
          <li>
            <strong>Wrong recording?</strong> You now get a warning when the recording and the JSON don't seem
            to be from the same call.
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
