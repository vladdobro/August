// AUG-199: the three side columns of the live panel. Subscribes to the stores itself so FileUpload does not re-render on every streamed word.
import React from 'react';
import LiveColumn from './LiveColumn';
import CopilotColumn from './CopilotColumn';
import AssistantColumn from './AssistantColumn';
import { copilotHintCount, useAssistantStore } from '../../services/assistantStore';
import type { PraxisProject } from '../../services/preferences';
import { shortcutLabel } from './platform';

interface LiveColumnsProps {
  actionItems: React.ReactNode;
  actionCount: number;
  projects: PraxisProject[];
  recentPaths: string[];
  onOpenSettings: (tab?: 'assistants') => void;
  copilot?: boolean; // AUG-200: false on the meeting-only socket
}

const LiveColumns: React.FC<LiveColumnsProps> = ({ actionItems, actionCount, projects, recentPaths, onOpenSettings, copilot = true }) => {
  const st = useAssistantStore();
  const hints = copilotHintCount();
  return (
    <>
      <LiveColumn colKey="ai" count={actionCount}>{actionItems}</LiveColumn>
      {copilot && (
        <LiveColumn colKey="cp" count={hints} headCount={false} shortcut={shortcutLabel('4')}>
          <CopilotColumn onOpenSettings={onOpenSettings} />
        </LiveColumn>
      )}
      <LiveColumn colKey="as" count={st.tabs.length} shortcut={shortcutLabel('3')}>
        <AssistantColumn projects={projects} recentPaths={recentPaths} onOpenSettings={onOpenSettings} />
      </LiveColumn>
    </>
  );
};

export default LiveColumns;
