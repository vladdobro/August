import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ASSISTANT_CHANNEL,
  type AssistantChannelAction,
  type AssistantChannelMessage,
  type AssistantSnapshot,
} from '../../services/assistantChannel';

/// AUG-199: compact windows render the assistant state published by the main window over BroadcastChannel and send
/// actions back. `hello` is repeated until the first state arrives, in case the main window mounted later.
export function useAssistantSnapshot(): { snap: AssistantSnapshot | null; send: (action: AssistantChannelAction) => void } {
  const [snap, setSnap] = useState<AssistantSnapshot | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(ASSISTANT_CHANNEL);
    channelRef.current = channel;
    let got = false;
    channel.onmessage = (event: MessageEvent<AssistantChannelMessage>) => {
      if (event.data?.type === 'state') {
        got = true;
        setSnap(event.data.state);
      }
    };
    const hello = (): void => channel.postMessage({ type: 'hello' } satisfies AssistantChannelMessage);
    hello();
    const timer = setInterval(() => {
      if (got) clearInterval(timer);
      else hello();
    }, 2000);
    return () => {
      clearInterval(timer);
      channel.close();
      channelRef.current = null;
    };
  }, []);

  const send = useCallback((action: AssistantChannelAction) => {
    channelRef.current?.postMessage({ type: 'action', action } satisfies AssistantChannelMessage);
  }, []);

  return { snap, send };
}
