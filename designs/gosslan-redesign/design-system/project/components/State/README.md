# State

Every screen must define five states before it is considered designed: loading, empty, error, offline and success. State blocks share one anatomy: 40px line icon, 17/24 title, 13/18 one-or-two-line explanation, one primary action.

- Loading uses 3–5 skeleton rows that match the final row geometry; no spinner-only full pages.
- Empty states explain *why* the surface is empty and give one next step. No marketing copy, no illustration.
- Errors appear next to the object that failed and always offer a retry. Never discard typed content.
- Offline is a 32px persistent bar under the title bar plus the header status; it must not cover the message list. Composing stays enabled and messages queue visibly.
- Transfer cards encode state with icon + word + progress, never colour alone: sending, paused, failed, complete.
