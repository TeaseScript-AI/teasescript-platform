# Player UI follow-ups

- **Status:** Active, non-implemented planning for the Standard Player presentation.
- **Current state:** See [`PHASE-STATUS.md`](../../PHASE-STATUS.md) and [`player/README.md`](../../player/README.md).
- **Boundaries:** This file does not define runtime/host protocols, package custom-view APIs, or accepted TeaseScript
  semantics. General cross-surface UI rules remain in [`UI-DESIGN-AND-ENGINEERING.md`](../UI-DESIGN-AND-ENGINEERING.md).

## Current working direction

### User-created tool columns inside one left panel

Keep one left tool panel. A `+` control adds another tool column inside that panel rather than creating another panel.
Here, a tool column is a user-created subdivision of the left panel, not another top-level Player Grid track. Each
column independently selects one available tool/tab and may switch to another at any time. The same tool may be
selected in multiple columns; selection itself is sufficient to keep that tool visible, so a separate pin concept is not
currently needed. Columns can be closed when the user prefers a quieter or narrower layout.

Do not automatically fill surplus width with extra tools. Additional simultaneous information should appear because the
user added columns, not because the interface wants to consume empty space. The left panel may grow to accommodate the
selected columns only while the protected Player area remains available.
Beyond that boundary, keep the panel bounded and scroll all tool columns together with one shared horizontal scrollbar
at the bottom of the strip rather than giving each column its own horizontal scrollbar.

Persistence remains open. Automatically restoring the last arrangement has low friction but can re-open a layout the
user did not expect on another viewport. Named/saved layouts are more deliberate and reusable but add management UI.
Supporting both is flexible but costs more complexity. Whichever direction is chosen should preserve the user's column
selections without treating temporary lack of space as a request to delete them.

### Protect the primary Player area

For the current wide/docked Player direction, treat a square media region as the horizontal lower bound while
allocating additional width to the left tool area: the media region should not become narrower than its own height.
This 1:1 rule is the current POC boundary and may be revised if representative Player use shows that another boundary
works better. Narrow/mobile overlay layouts may use a different presentation and should not be forced through the
wide/docked rule.

### Content-aware tool-column sizing

Let tool content influence a column's preferred width, but bound that preference by the protected Player area and useful
wrapping. A single long sentence that can wrap should not claim a very wide column at the expense of other columns. At
the same time, genuinely wide or dense content should not be made unnecessarily narrow when doing so creates avoidable
vertical scrolling or destroys readability.

Start with browser-native CSS sizing and wrapping (`minmax()`, intrinsic sizing, `fit-content()`, Grid/Flex sizing, and
container queries where useful). Do not begin with a global JavaScript "optimal width" allocator: give columns bounded
preferred sizes, let the browser perform normal layout, and let the shared strip handle overflow. Add JavaScript
measurement or allocation logic only if a concrete layout case cannot be expressed reliably with CSS. The exact width
negotiation for several columns with different content remains a POC question.

## Open Player follow-ups

- [ ] **Prototype multi-column tool sizing.** Exercise one to several tool columns with short text, long wrappable text,
  tables/log-like content, mixed content needs, the 1:1 media boundary, and whole-strip horizontal scrolling.
- [ ] **Choose persistence behavior.** Decide which Player UI preferences survive reload/session changes and whether the
  tool layout is restored automatically, explicitly saved, or both. Candidate preferences include tool columns, panel
  state, media fit, and user-facing text/display preferences; inclusion is not yet decided.
- [ ] **Implement smart transcript following.** Follow new messages while the user is at the latest content; stop
  pulling the view down when the user scrolls back, and provide an explicit way to return to the latest message.
- [ ] **Add a layout debug mode.** Make development-only inspection of important Grid/container geometry, active layout
  conditions, overlays, safe areas, and measured available space easy enough to diagnose viewport-specific failures.
- [ ] **Complete reduced-motion/accessibility handling.** Preserve the existing `prefers-reduced-motion` direction and
  evaluate the remaining Player-specific needs for readable scaling, contrast, control sizing, and browser accessibility
  behavior as real interactions replace demo presentation.
- [ ] **Define status/notification presentation.** Provide temporary Player status such as saved/paused/error/assignment
  updates without forcing every status into the transcript or allowing transient chrome to disturb primary layout.
- [ ] **Resolve the Standard UI/custom UI boundary.** Decide which Player shell responsibilities stay platform-owned and
  which presentation a package custom view may replace or style. Keep the lifecycle, state, isolation, and API contract
  in the roadmap's custom-view work rather than duplicating that design here.

Older exploratory Player ideas are not automatically part of this list. Add them only after the Owner selects them for
active planning or implementation.
