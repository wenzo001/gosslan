# Input & composer

The composer is a floating rounded card, not a full-width strip.

- Desktop: 16px side margins, 12px bottom margin, 22px radius, `surface-raised` + `shadow-md`; the message list breathes around it.
- Left: attach, image, emoji; right: a 38px gradient send disc (solid violet when disabled).
- The field itself is borderless; focus is a 2px `focus-ring` on the card, not an inner outline.
- Empty content: send disc becomes `surface-field` with `text-tertiary`; it never disappears.
- Multi-line input grows to 160px, then scrolls internally.
- Search fields use `surface-field`, 10px radius, no visible border at rest.
- Error text sits below the field, 12px `danger-ink`, with an icon.
- Mobile: 40px pill inside a 44px touch row; attachment/emoji are 44px targets.
