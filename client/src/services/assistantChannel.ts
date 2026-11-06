/// AUG-199: BroadcastChannel between the main window (assistantStore publishes) and the compact Copilot / Assistant
/// windows (they render the snapshot and send actions). Same origin, so no IPC is needed; one WebSocket stays in the main window.
export const ASSISTANT_CHANNEL = 'august-assistant';

export interface CompactExchange {
  askId: string;
  question: string;
  answer: {
    text: string;
    tools: string[];
    streaming: boolean;
    actionState?: 'added' | 'duplicate';
    task?: { state: 'creating' | 'done' | 'failed'; taskId?: string; direct?: boolean };
  } | null;
  noAnswer: boolean;
}

export interface AssistantSnapshot {
  live: boolean; // a meeting socket is connected (Live Text or meeting-only)
  transcript: boolean; // AUG-200
  tabs: Array<{ projectPath: string; name: string; mark: 'run' | 'idle' | 'err' }>;
  activeProjectPath: string | null;
  view: 'none' | 'ready' | 'off' | 'missing' | 'signed-out' | 'too-old' | 'unsupported' | 'budget' | 'limit' | 'error';
  praxisDown: boolean;
  streaming: boolean;
  inputDisabledReason: string | null; // plain text placeholder when input is off
  last: CompactExchange | null; // last exchange of the active tab
  copilot: {
    mode: 'off' | 'local' | 'claude' | 'always';
    hintCount: number;
    text: string | null;
    /// AUG-197: newest shown hints of the active tab (at most 3), without dismissed ones.
    hints: Array<{ hintId: string; state: 'searching' | 'found' | 'explained'; title: string; text: string; clock: string }>;
    statusText: string | null; // PraxisOS off / spending limit reached
    fallbackLocal: boolean; // a Claude mode is chosen but Claude Code is not available: runs as Local hints
  };
  windowMin: number;
}

export type AssistantChannelAction =
  | { kind: 'ask'; text: string }
  | { kind: 'stop' }
  | { kind: 'set-active'; projectPath: string }
  | { kind: 'to-action'; askId: string }
  | { kind: 'to-task'; askId: string }
  | { kind: 'copy'; askId: string }
  | { kind: 'copilot-dismiss'; hintId: string }
  | { kind: 'copilot-ask'; hintId: string }
  | { kind: 'show-copilot' }; // CTX badge in a compact window: expand to the full window and show COPILOT

export type AssistantChannelMessage =
  | { type: 'state'; state: AssistantSnapshot }
  | { type: 'hello' }
  | { type: 'action'; action: AssistantChannelAction };
