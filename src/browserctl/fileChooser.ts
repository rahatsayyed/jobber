// browserctl file chooser: click a control that opens the browser's file dialog and hand it exactly one in-memory file.
// Code-owned: the caller (the engine's attachFile) resolved the file from SQLite and the renderer folder; no model value reaches here.
// The file goes in as a payload (name, type, bytes), so the upload name is the generic one and the on-disk name never leaves the machine.

export interface ChooserFile { name: string; mimeType: string; buffer: Buffer }

interface ChooserLike { setFiles(files: unknown): Promise<void> }
interface PageLike { waitForEvent?: (name: string, opts?: { timeout?: number }) => Promise<ChooserLike> }

export const CHOOSER_TIMEOUT_MS = 8000;

/** Wait for the `filechooser` event while `click` runs, then answer it with `file`. Throws when no chooser opens. */
export async function answerFileChooser(page: unknown, click: () => Promise<void>, file: ChooserFile, timeoutMs: number = CHOOSER_TIMEOUT_MS): Promise<void> {
  const pg = page as PageLike;
  if (typeof pg?.waitForEvent !== 'function') throw new Error('browserctl: page cannot wait for a file chooser');
  const opened = pg.waitForEvent('filechooser', { timeout: timeoutMs });
  opened.catch(() => undefined); // a rejected wait is handled below; never an unhandled rejection
  await click();
  const chooser = await opened;
  await chooser.setFiles({ name: file.name, mimeType: file.mimeType, buffer: file.buffer });
}
