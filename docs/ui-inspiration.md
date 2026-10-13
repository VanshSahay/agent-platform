# UI and UX inspiration from Wajo

Two sources: Wajo's published design document (`wajo.ai/design.md`, a public file they ship for their own agents) and the product patterns observed in the Fo client ([research/wajo-fo-build.md](research/wajo-fo-build.md), [research/wajo-fo.md](research/wajo-fo.md)). We take the taste and the interaction patterns; we do not copy their palette, mascot or copy verbatim. Circle's page is `web/index.html`.

## The taste, in their words and ours

Wajo's one paragraph: "Quiet luxury. Restrained palette, generous whitespace, calm typography. A single accent used sparingly, never as a fill. Hairline borders. Soft shadows at large radii. Long easings that suggest rather than announce. Copy that respects the reader. Nothing shouts."

What that means for Circle, concretely:

| Principle | Wajo's value | Circle's value |
|---|---|---|
| Surface | cream `oklch(0.995 0.0034 67.78)`, paper white cards, cream-2 sidebar | warm off-white `oklch(0.985 0.004 80)`, white cards, a slightly deeper sidebar |
| Text | near-black `oklch(0.1776 0 0)`, two muted greys | near-black `oklch(0.2 0.01 60)`, two muted greys |
| Borders | 1px at 7% and 13% black, never 2px at 100% | same rule, 7% and 13% |
| Accent | one deep moss `oklch(0.44 0.07 139)`; olive only for charts and celebration | one deep teal-ink `oklch(0.42 0.07 200)`; a warm amber only for "needs you" marks |
| Type | Inter, DM Mono; three weights per screen | Inter, system mono; three weights (400, 500, 600) |
| Radius | 14px, 4px small | 14px, 6px small |
| Motion | ease-out curves such as `cubic-bezier(0.23, 1, 0.32, 1)`; UI transitions under 300ms; no `transition: all`; no `scale(0)`; no animation on keyboard actions | same rules; the composer slides from centre to bottom in 320ms on the first message, the only choreographed motion |
| Layout | whitespace is the structure; chat views bound to the viewport with one overflow | same; the thread is `calc(100dvh - chrome)` with `min-height: 0` |

Their anti-patterns list is worth keeping as a review checklist: loud fills, two accents on one screen, five font weights, `transition: all`, `ease-in`, `scale(0)` on enter, durations over 300ms on UI, animated keyboard actions, hardcoded recurring colours, native `title` tooltips, a page scrollbar on a chat surface.

## Interaction patterns we adopt

1. **Home is three tabs over one list.** "Need your input", "On radar", "Last activity", each with an empty state that says what will appear there and why. Ours use the same shape with our own copy ("Nothing needs you. When Pip gets stuck on something only you can answer, it waits here.").
2. **A greeting and three suggestion cards above the composer** on an empty thread, each a plain sentence the person could have typed, with "Show another" rotating from a pool. Ours are drawn from the errands the product is for: a repair, a ride, a phone lesson, a bill, a recommendation.
3. **The composer starts centred and moves to the bottom** on the first message. One motion, long ease-out, nothing else animates.
4. **Every reply carries a collapsed "Completed N steps"** line that expands to one row per recorded tool call with its label and a check when it has evidence; failed and stopped rows are marked. Ours is built from the stored tool call records, the same source as the footer.
5. **A working line while a run is in flight** ("Pip is working…", then the running tool's label, then the last progress note), replaced by the reply when it lands.
6. **Approvals are held cards, not modals.** "Needs your go-ahead" sits in the thread and in the inbox with Yes and No; the answer is a message. Ours routes guest requests to the owner's own chat with the agent and shows "I've asked Ellie to OK that" in the group.
7. **Plain words everywhere.** No jargon, no "AI", short sentences, one question at a time. A single page-level line, "Pip can make mistakes, so double-check.", instead of per-message disclaimers.
8. **Responsibilities and schedules read as sentences** ("Weekdays at 9:00 AM", "Next run Oct 15, 2:00 PM"), never as cron.

## What we deliberately do differently

- **The room is the unit, not the chat with the agent.** Wajo's home is personal. Ours shows the rooms a person is in; the inbox is what those rooms need from them.
- **Who can answer is visible.** Cards say who asked and who can decide; an owner or decider answering on a guest's behalf is a first-class path.
- **No mascot.** Fo's animated face carries agent state. Circle uses the working line and a small state dot; the agent is a presence in the chat, not a character on the page.
- **Private versus room is explicit** in the memory view: each note shows its scope so a person can see what stays private.
