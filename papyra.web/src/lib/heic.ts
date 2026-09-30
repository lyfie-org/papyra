// iPhone photos arrive as HEIC, which only Safari can show and the server
// can't thumbnail. Where the browser can decode one, it is turned into a JPEG
// before upload (upright — the orientation is applied while decoding), so it
// shows everywhere and gets thumbnails. Where it can't, the original goes up
// unchanged and appears as a file card: nothing is lost either way.

const HEIC = /\.(heic|heif)$/i;

export function isHeic(file: File): boolean {
  return HEIC.test(file.name) || /^image\/hei[cf]/i.test(file.type);
}

export async function heicToJpeg(file: File, quality = 0.9): Promise<File> {
  if (!isHeic(file) || typeof createImageBitmap !== 'function') return file;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const g = canvas.getContext('2d');
    if (!g) return file;
    g.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob || blob.type !== 'image/jpeg') return file;
    const name = file.name.replace(HEIC, '') + '.jpg';
    return new File([blob], HEIC.test(file.name) ? name : `${file.name}.jpg`, { type: 'image/jpeg', lastModified: file.lastModified });
  } catch {
    return file; // this browser can't decode HEIC: upload it as it is
  } finally {
    bitmap?.close();
  }
}
