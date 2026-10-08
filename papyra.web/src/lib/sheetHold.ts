// A note's sheet grows to fit its body, up to the window. On open the body
// arrives a beat after the sheet — attachment sizes are fetched first, then the
// editor mounts and loads the markdown — so a long note opened as a short sheet
// and then jumped to full height, throwing the footer down the screen (a large
// layout shift on every long note). A body that is sure to fill the sheet
// holds it at full height from the first frame instead.

// Lower bounds, so a note is only held when it certainly overflows: a line of
// text is at least this tall, an attachment at least this.
const LINE_PX = 24;
const EMBED_PX = 100;
// The sheet's chrome around the body: title bar, tag row, padding, footer.
const CHROME_PX = 200;
// The sheet's height cap (NoteEditor.css `max-height: 92vh`).
const SHEET_MAX = 0.92;

/** Whether `body` is certain to be taller than the sheet can grow. */
export function fillsSheet(body: string, viewportHeight: number): boolean {
  if (!body) return false;
  const room = viewportHeight * SHEET_MAX - CHROME_PX;
  if (room <= 0) return true;
  let height = 0;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const embeds = trimmed.match(/!\[/g)?.length ?? 0;
    height += embeds > 0 ? embeds * EMBED_PX : LINE_PX;
    if (height > room) return true;
  }
  return false;
}
