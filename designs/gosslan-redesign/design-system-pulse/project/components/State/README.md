# State

Every screen defines five states before it is designed: loading, empty, error, offline and success. Pulse keeps empty states quiet and useful.

- Empty: a 48px line icon, 20/26 title, 13/18 one-or-two-line explanation, one primary action. No halo, orb or looping background animation.
- Loading: 3–5 skeleton rows that match the final geometry; no full-page spinner.
- Error: next to the failed object, with a retry; never discard typed content.
- Offline: 32px persistent bar under the title bar plus header status; composing stays enabled and queues visibly.
- Transfer: icon + word + progress + speed/reason; completed stays for 3 seconds with "打开" before moving to Task Center history.
- Reduced motion keeps a 120ms fade only.
