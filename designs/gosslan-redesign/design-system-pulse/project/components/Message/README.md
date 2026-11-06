# Message

The message system is the product. Pulse keeps a familiar chat rhythm and one clear own-bubble colour.

- 1:1 chats have **no avatar column**; group chats show a 24px avatar and an 11px sender name on the first message of a run.
- Own messages: solid `#2f6bff`, white text, right aligned, 18px radius with the bottom-right corner at 6px.
- Other messages: `bubble-in` `#f2f3f5`, left aligned, 18px radius with the bottom-left corner at 6px, 1px `#e5e6eb` border.
- Within one sender's run, bubble gap is 2px; between runs, 12px.
- One-line bubble height is 38px (9px vertical + 20px line). Do not use 16px+ vertical padding.
- Timestamps belong to a run, not every bubble; the last bubble shows an 11px time underneath.
- Delivery state appears only under the sender's last message: clock / single check / double check (green) / alert + "重试".
- Quote is a hairline-inset block inside the bubble.
- Reactions are 28px pills that pop in at 220ms; overflow is "+N".
- Image bubbles have no padding and a 14px radius; file bubbles use an icon tile + two lines of metadata.
- Own bubbles are always solid. User-customised colours are a preference, not a decorative gradient.
