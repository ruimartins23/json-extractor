import { useMemo, useState } from 'react';
import { Dropzone } from './components/Dropzone';
import type { ScenarioSelection } from './components/Dropzone';
import { TimelineView } from './components/TimelineView';
import { parseAITrainingJSON } from './utils/parser';
import type { OrganizedTimeline, EnvironmentMode, ParserConfig } from './utils/parser';
import { BrainCircuit } from 'lucide-react';
// The /react entry point, not /next: this is a Vite SPA.
import { Analytics } from '@vercel/analytics/react';
import { AppearanceMenu } from './components/AppearanceMenu';
import { Announcement } from './components/Announcement';

function App() {
  const [timelineData, setTimelineData] = useState<OrganizedTimeline | null>(null);
  const [scenario, setScenario] = useState<ScenarioSelection>({ num: 1, gender: 'male' });
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  // Kept so the same file can be read again under a different environment.
  const [source, setSource] = useState<{ data: unknown; config: ParserConfig } | null>(null);
  // Only a recording so far: how to read the JSON once it is added.
  const [audioOnly, setAudioOnly] = useState<{ mode: EnvironmentMode; config: ParserConfig } | null>(null);
  // Stable, so the session view does not take every render for a new file.
  const noSession = useMemo<OrganizedTimeline>(
    () => ({ agentType: audioOnly?.mode ?? 'prod single agent', events: [] }),
    [audioOnly],
  );

  /** Returns a reason to stay put, or null when the session opened. */
  const handleFileParsed = (
    data: unknown,
    mode: EnvironmentMode,
    config: ParserConfig,
    selectedScenario: ScenarioSelection,
    media: File | null,
  ): string | null => {
    const parsed = parseAITrainingJSON(data, mode, config);
    // Valid JSON with nothing in it is almost always the wrong file or the wrong
    // environment. An empty results page would just look broken.
    if (parsed.events.length === 0) {
      return 'That file parsed fine but no conversation or tool calls were found in it. Check the environment above matches the session, and that this is the full JSON.';
    }
    setScenario(selectedScenario);
    setMediaFile(media);
    setSource({ data, config });
    setTimelineData(parsed);
    return null;
  };

  /** Opens the audio tools with just the recording; the JSON can follow. */
  const startWithRecording = (
    media: File,
    mode: EnvironmentMode,
    config: ParserConfig,
    selectedScenario: ScenarioSelection,
  ) => {
    setScenario(selectedScenario);
    setMediaFile(media);
    setAudioOnly({ mode, config });
  };

  /** The JSON added after the recording, read with the settings chosen at the start. */
  const addJson = (data: unknown): string | null => {
    if (!audioOnly) return null;
    const parsed = parseAITrainingJSON(data, audioOnly.mode, audioOnly.config);
    if (parsed.events.length === 0) {
      return 'That file parsed fine but no conversation or tool calls were found in it. Check this is the full JSON for this session. To read it as another environment, start over and pick it on the first page.';
    }
    setSource({ data, config: audioOnly.config });
    setTimelineData(parsed);
    setAudioOnly(null);
    return null;
  };

  /** Reads the file already loaded again, so a wrong setting is fixable in place. */
  const reparse = (mode: EnvironmentMode, config: ParserConfig) => {
    if (!source) return;
    setSource({ data: source.data, config });
    setTimelineData(parseAITrainingJSON(source.data, mode, config));
  };

  const changeMode = (mode: EnvironmentMode) => {
    if (!source) return;
    const config = { ...source.config };
    // Pre-prod names its tool calls differently. Only swap a keyword still left
    // at one of the defaults, so anything hand-typed survives the switch.
    if (config.functionKeyword === 'toolCall' || config.functionKeyword === 'PythonFunctionTool') {
      config.functionKeyword = mode === 'pre-prod' ? 'toolCall' : 'PythonFunctionTool';
    }
    reparse(mode, config);
  };

  const changeConfig = (config: ParserConfig) => {
    if (timelineData) reparse(timelineData.agentType, config);
  };

  const reset = () => {
    setTimelineData(null);
    setMediaFile(null);
    setSource(null);
    setAudioOnly(null);
  };

  const inSession = timelineData !== null || audioOnly !== null;

  return (
    <div className="gradient-bg app-container">
      <a className="skip-link" href="#main">Skip to content</a>
      <AppearanceMenu />

      <header className={`header animate-fade-in ${inSession ? 'compact' : ''}`}>
        <div className="header-icon-container glass">
          <BrainCircuit className="header-icon" />
        </div>
        <h1>
          JSON <span className="gradient-text">Extractor</span>
        </h1>
        {!inSession && (
          <p>
            Load an agent session to step through its transcript, tool calls and transfers.
          </p>
        )}
      </header>

      <main className="main-content" id="main">
        <Announcement />
        {!inSession ? (
          <Dropzone onFileParsed={handleFileParsed} onRecordingOnly={startWithRecording} />
        ) : (
          <TimelineView
            data={timelineData ?? noSession}
            audioOnly={!timelineData}
            onAddJson={addJson}
            onReset={reset}
            onModeChange={changeMode}
            config={source?.config}
            onConfigChange={changeConfig}
            scenario={scenario}
            mediaFile={mediaFile}
          />
        )}
      </main>
      
      <footer className="footer">
        <p>Single and multi agent support</p>
      </footer>

      <Analytics />
    </div>
  );
}

export default App;
