// AUG-188: in Ghost Mode the main window is hidden and has no document focus, so navigator.clipboard rejects; the
// desktop bridge writes the clipboard from the main process.
export async function writeClipboard(text: string): Promise<void> {
  const bridge = window.august?.writeClipboard;
  if (bridge) {
    const r = await bridge(text);
    if (!r.ok) throw new Error('clipboard write failed');
    return;
  }
  await navigator.clipboard.writeText(text);
}
