// A video scrolled out of view stops playing — nobody watches it there, and a
// note with several clips shouldn't keep decoding them all. One
// IntersectionObserver serves every video on the page; a container is watched
// for videos coming and going (the editor mounts and unmounts them as the note
// changes). It never starts a video, only pauses one; picture-in-picture is
// left alone (it is visible, just elsewhere).

let observer: IntersectionObserver | null = null;
const watched = new Map<HTMLVideoElement, number>(); // video → containers watching it

function shared(): IntersectionObserver | null {
  if (typeof IntersectionObserver === 'undefined') return null;
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const video = entry.target as HTMLVideoElement;
      if (entry.isIntersecting || video.paused) continue;
      if (document.pictureInPictureElement === video) continue;
      video.pause();
    }
  }, { threshold: 0 });
  return observer;
}

function watch(video: HTMLVideoElement) {
  const io = shared();
  if (!io) return;
  const n = watched.get(video) ?? 0;
  if (n === 0) io.observe(video);
  watched.set(video, n + 1);
}

function unwatch(video: HTMLVideoElement) {
  const n = watched.get(video);
  if (!n) return;
  if (n > 1) { watched.set(video, n - 1); return; }
  watched.delete(video);
  observer?.unobserve(video);
}

/** Pause every video inside `container` when it leaves the viewport. Returns a stop function. */
export function pauseOffscreenVideos(container: HTMLElement): () => void {
  const mine = new Set<HTMLVideoElement>();
  const scan = () => {
    const now = new Set(container.querySelectorAll('video'));
    for (const v of now) if (!mine.has(v)) { mine.add(v); watch(v); }
    for (const v of [...mine]) if (!now.has(v)) { mine.delete(v); unwatch(v); }
  };
  scan();
  const mo = new MutationObserver(scan);
  mo.observe(container, { childList: true, subtree: true });
  return () => {
    mo.disconnect();
    for (const v of mine) unwatch(v);
    mine.clear();
  };
}
