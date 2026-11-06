# Row

List rows are the densest surface in the product. They must scan in under a second.

- Height 68px, 16px horizontal inset, 12px gap between avatar and text.
- Name: 15/20, weight 500 (600 only when unread). Preview: 13/18, `text-secondary`, one line, ellipsis.
- Time: 11px, `text-tertiary`, tabular numerals, top aligned.
- Unread: one 18px minimum pill on `accent`; muted chats show a small bell instead. Never stack two badges.
- Selected row: `accent-soft` fill across the full row; no left colour bar.
- Pinned rows sit at the top with a 10px "置顶" label, not a separate section.
- Group avatars are 12px rounded squares; people are circles. Presence dot is 10px with a 2px surface ring.
- Contact rows add a 30px action button (message) on the right; do not use a chevron as the only affordance.
