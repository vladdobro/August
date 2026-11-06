import { Router } from 'express';

import {
  addAssistantItemToList,
  getOpenLiveActionItems,
  isValidLiveKey,
  mutateLiveActionItems,
  type AssistantItemResult,
} from '../services/liveActionItems.js';
import { loopbackOnly } from './capture.js';

/// AUG-199: REST mirror of the assistant's add_action_item (browser build and tests). Loopback only.
const router = Router();
router.use(loopbackOnly);

router.post('/:liveKey/action-items', async (req, res) => {
  const liveKey = req.params.liveKey;
  if (!isValidLiveKey(liveKey)) {
    res.status(400).json({ error: 'Invalid liveKey' });
    return;
  }
  const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
  const raw = { text: body.text, owner: body.owner, praxisTaskId: body.praxisTaskId, projectPath: body.projectPath };
  try {
    const store = getOpenLiveActionItems(liveKey);
    let result: AssistantItemResult | null;
    if (store) {
      result = store.addAssistantItem(raw);
    } else {
      let captured: AssistantItemResult | null = null;
      const file = await mutateLiveActionItems(liveKey, (items) => {
        const r = addAssistantItemToList(items, raw);
        captured = r.result;
        return r.changed;
      });
      if (!file) {
        res.status(404).json({ error: 'Unknown liveKey' });
        return;
      }
      result = captured;
    }
    if (!result) {
      res.status(400).json({ error: 'text must be 1-300 characters' });
      return;
    }
    res.json(result);
  } catch {
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

export default router;
