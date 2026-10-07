// Links in Markdown/MDX that leave papyra.app open in a new tab, so a reader
// never loses their place in the docs. Same-site links (including /demo) stay
// in the tab. A tiny tree walk rather than a dependency.

const SITE = 'papyra.app';

function isExternal(href) {
  if (typeof href !== 'string' || !/^https?:\/\//i.test(href)) return false;
  try {
    const host = new URL(href).hostname;
    return host !== SITE && host !== `www.${SITE}`;
  } catch {
    return false;
  }
}

export default function rehypeExternalLinks() {
  const walk = (node) => {
    if (node.type === 'element' && node.tagName === 'a' && isExternal(node.properties?.href)) {
      node.properties.target = '_blank';
      node.properties.rel = ['noopener', 'noreferrer'];
    }
    for (const child of node.children ?? []) walk(child);
  };
  return walk;
}
