# Button

Primary, secondary, ghost, destructive and icon buttons. One 36px control height on desktop, 44px on touch. Labels are verbs; never use "确定" as the only label for a destructive action.

- Primary: `accent` fill, white label, 8px radius.
- Secondary: `surface-field` fill, primary text.
- Ghost: transparent, hover `surface-field`.
- Destructive: `danger` fill only for irreversible actions; otherwise `danger-ink` text on ghost.
- Loading keeps the label width; a 14px spinner replaces the leading icon.
- Disabled: `opacity 0.48`, no shadow, cursor not-allowed.
