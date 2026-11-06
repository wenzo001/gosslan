# Input & composer

Search fields and text inputs sit on `surface-field` with an 8px radius and **no visible border** at rest. Focus adds a 2px `focus-ring` outside the field. The composer is not a floating card: it is a full-width row divided by a hairline, with a 36px send button.

- Placeholder uses `text-tertiary`; typed text uses `text-primary`.
- Error text sits below the field, 12px `danger-ink`, with an icon.
- The send button is disabled (field-coloured) when empty; it never disappears.
- Multi-line input grows to 160px, then scrolls internally.
- Attach, image and emoji are 30px icon buttons on the left of the composer.
