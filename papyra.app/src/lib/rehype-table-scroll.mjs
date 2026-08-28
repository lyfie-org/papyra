/**
 * Wrap every Markdown table in a horizontally scrollable div.
 *
 * A wide table is the one piece of prose content that reliably breaks a
 * responsive layout: on a narrow screen it forces the whole page to scroll
 * sideways. Tables should scroll inside their own box instead, so the body never
 * does. Markdown gives no way to add that wrapper by hand, hence a plugin.
 *
 * Written as a plain recursive walk rather than pulling in unist-util-visit —
 * it is a parent-replacement, which visit makes awkward, and it saves a
 * dependency for fifteen lines.
 */
export default function rehypeTableScroll() {
  return (tree) => {
    const walk = (node) => {
      if (!Array.isArray(node.children)) return;

      node.children = node.children.map((child) => {
        walk(child);
        if (child.type !== 'element' || child.tagName !== 'table') return child;
        return {
          type: 'element',
          tagName: 'div',
          properties: { className: ['table-scroll'] },
          children: [child],
        };
      });
    };

    walk(tree);
  };
}
