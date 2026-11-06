# Overlay

Overlays are the only place shadows and elevation are allowed; shadows stay neutral, with no coloured tint.

- Context menu: 210–240px, `surface-raised`, 10px radius, `shadow-md`, 6px padding, 32px rows, 16px icons. Destructive rows use `danger-ink` and sit after a divider.
- Dialog: max 420px, 12px radius, `shadow-dialog`, 24px padding, title 17/24, body 13/18, actions right aligned with the primary last. Destructive confirmation names the object and the consequence.
- Action sheet (mobile): bottom anchored, 12px top radius, 8px side margins, 50px rows, separate "取消" block.
- Toast: bottom centre on mobile, bottom right on desktop; 4s max; icon + text, no full-colour fill. Errors include a retry action.
- Scrim: `#0f121675` light, `#000000b3` dark. It covers the workspace, not the draggable title bar; a full-page experience (Discover) replaces a modal when the task deserves the space.
- Add friend, create group and forward are no longer cramped modals if the task is exploratory: use the full-page Discover stage.
