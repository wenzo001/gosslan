# Overlay

Overlays are the only place shadows and elevation are allowed.

- Context menu: 210–240px, `surface-raised`, 10px radius, `shadow-md`, 6px padding, 32px rows, 16px icons. Destructive rows use `danger-ink` text and stay at the bottom after a divider.
- Dialog: max 420px, 12px radius, `shadow-dialog`, 24px padding, title 17/24, body 13/18, actions right aligned with the primary action last. Destructive confirmation names the object and the consequence.
- Action sheet (mobile): bottom anchored, 12px top radius, 8px side margin, 44px rows, separate "取消" block.
- Toast: bottom centre on mobile, bottom right on desktop; 4s max; icon + text, no full-colour fill. Errors include a retry action and stay until dismissed.
- Scrim: `#10111466` in light, `#000000a6` in dark. Clicking the scrim closes only non-destructive dialogs.
