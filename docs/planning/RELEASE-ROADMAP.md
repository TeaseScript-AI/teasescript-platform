# Release roadmap

This roadmap keeps future product work visible without turning every worthwhile idea into a GitHub issue. It records
owner-selected release-stage placement and compact progress history; it does not schedule implementation or replace the
accepted sources that define architecture, syntax, behavior, or current implementation state.

Release stages describe the maturity target for the product work selected for that stage. Individual subsystems may
mature earlier or later, and a stage does not require every planned product surface to exist.

## How to use this roadmap

- The Owner or designated coordinator selects roadmap placement. Agents may propose entries or moves.
- A section is the current target stage, not a permanent deadline. Move an item earlier or later when evidence,
  priorities, dependencies, or measured constraints justify it.
- Keep entries short. Put detailed design, acceptance criteria, and implementation plans in their canonical documents
  only when they are needed.
- A roadmap item does not need a GitHub issue. Create an issue when the work becomes concrete enough for near-term
  execution.
- Roadmap placement does not by itself accept architecture, syntax, compatibility, product behavior, or an
  implementation approach.
- A checked item may remain as compact roadmap progress history. Current implementation state stays in
  `PHASE-STATUS.md`, current topic documents, and code; accepted contracts stay in their ADRs or specifications.

### Item format

Use only the optional fields that add useful information. `Outcome` is the normal minimum.

```markdown
- [ ] **Short title**
  - **Outcome:** One or two sentences describing what should become true.
  - **Trigger:** Optional condition or evidence that should cause this item to be reconsidered, moved, or started.
  - **Reference:** Optional link to an existing planning document, decision, wish, or issue when that context is useful.
```

`[ ]` means the roadmap outcome is still open; `[x]` means that outcome is complete. Do not repeat the stage inside an
item because its section already supplies it.

## POC / Foundation

**Goal:** Prove the core technical foundations: TeaseScript, compilation, deterministic execution, save/resume,
Player/runtime boundaries, and the development tooling needed to exercise them.

**Expectation:** The system may still be developer-oriented and incomplete. Internal APIs, formats, tooling, and
architecture may change substantially while correctness and the basic model are being proven.

## Alpha

**Goal:** Turn the proven foundation into a coherent usable product slice that can be exercised meaningfully, especially
the scripting, editor/tooling, and Player experience selected for alpha.

**Expectation:** Selected core flows should work together well enough for sustained testing. A complete production
website, community platform, or every planned product feature is not required. Rough UX, missing secondary capabilities,
and breaking changes remain acceptable.

## Beta

**Goal:** Exercise the selected product scope under realistic usage and integrate the additional product surfaces needed
for broader testing and eventual release.

**Expectation:** Shift emphasis from proving concepts to reliability, usability, performance, security, browser
behavior, persistence, operational behavior, and integration. Major redesign becomes less desirable, but different
subsystems may still have different maturity levels.

## Release Candidate

**Goal:** Validate a specific candidate containing the scope selected for the first stable release.

**Expectation:** The intended 1.0 scope is effectively frozen. Work is dominated by blockers, regressions,
compatibility or migration problems, documentation gaps, and release verification rather than new features.

## 1.0 / Stable Release

**Goal:** Release the selected first stable product scope for normal supported use.

**Expectation:** The included functionality has deliberate compatibility, persistence, security, upgrade,
documentation, and operational expectations. `1.0` does not mean every desirable TeaseScript Platform feature has been
implemented.

## Future / Post-1.0

**Goal:** Preserve valuable capabilities, optimizations, and product directions that do not need to block `1.0`.

**Expectation:** No implementation commitment. Move work earlier when evidence or product priorities justify it.
