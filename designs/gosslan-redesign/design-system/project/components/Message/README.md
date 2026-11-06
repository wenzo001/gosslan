# Message

The message system is the product. It follows iMessage's economy rather than card-chat density.

- 1:1 chats have **no avatar column**; group chats show a 24px avatar and an 11px sender name on the first message of a run.
- Own messages: `bubble-out` with white text, right aligned, 18px radius with the bottom-right corner at 6px.
- Other messages: `bubble-in`, left aligned, 18px radius with the bottom-left corner at 6px.
- Within one sender's run, bubble gap is 2px; between runs, 12px.
- One-line bubble height is 36px (10px vertical + 20px line). Do not use 16px+ vertical padding.
- Timestamps belong to a run, not to every bubble; the run's last bubble shows an 11px time underneath on demand.
- Delivery state appears only under the sender's last message: clock (sending), single check (sent), double check (read), alert + "重试" (failed).
- Quote is a hairline-inset block inside the bubble, not a separate chip above it.
- Reactions sit on the bubble's lower edge as 20px pills; overflow is "+N".
- Image bubbles have no padding and a 12px radius; file bubbles use an icon tile + two lines of metadata.
- Group messages separate speakers by name and avatar, not by different bubble colours.
