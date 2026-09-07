---
name: digital-interface-design
description: >-
  Design or substantially redesign frontend interfaces with a distinctive, intentional visual direction. Use when
  creating or reshaping websites or application UI where composition, typography, color, hierarchy, responsive
  behavior, interaction states, or rendered visual quality are central. Especially useful for complex stateful
  interfaces. Do not use for narrow visual bug fixes or non-visual frontend work.
---
# Digital Interface Design

Act as a design lead, not a component assembler. Make choices that are specific to the brief, audience, product, and
real content. A technically correct interface can still be visually generic; aim for a coherent point of view that
improves comprehension, use, and identity.

## Ground the design in the product

Before choosing a direction, identify the audience, primary job, most important content/actions, subject matter and
tone, and any existing functional or accessibility behavior that must survive. Use those facts as design material.

Do not let the current DOM, component library, demo content, or existing layout become the visual brief by accident. Do
not invent product capabilities merely to create visual interest.

For a content-oriented site, make the opening viewport express the subject and purpose rather than defaulting to a
generic hero recipe. For an application, make the primary workspace or task surface visually dominant; navigation,
settings, tools, status, and other chrome should support the work rather than compete with it.

## Form a visual point of view before coding

Create a compact design plan:

- **Thesis:** the intended experience and what makes it specific to this brief.
- **Typography:** families, roles, scale, weight, width, spacing, and reading measure.
- **Color:** a small role-based palette for canvas, surfaces, text, borders, accents, and meaningful states.
- **Composition:** the main spatial idea, alignment, density, and hierarchy.
- **Details:** shape language, borders/elevation, icon treatment, imagery, and decorative vocabulary.
- **Motion/state:** what changes, why, and how the hierarchy responds to content, interaction, width, and height.

Consider at least one materially different composition before committing. Review the plan against the brief before
building: if a choice could be transplanted unchanged into an unrelated product, justify it from the content or replace
it.

If the brief deliberately fixes a visual direction, follow it. Anti-template guidance is a check against unconscious
defaults, not a reason to override an explicit design request.

## Make typography, structure, and words carry meaning

Typography is part of identity and hierarchy, not a neutral wrapper. Choose it deliberately rather than reaching for the
same fashionable family or pairing. One family can be enough; if using two, make the contrast and roles meaningful.
Establish clear text roles and use size, weight, width, spacing, and line length with intent. When display type is a
visual element, let the type treatment itself carry character rather than decorating it with unrelated effects.

Visual structure should explain relationships. Start with alignment, spacing, type hierarchy, and grouping before
adding containers. Borders, dividers, numbering, labels, cards, groups, columns, and surface changes should encode real
information. A number should indicate sequence or rank; a badge should indicate a real category or state; a card should
represent a meaningful bounded unit.

Words are design content. Use plain user-facing language, keep action names consistent through a flow, and make empty
and failure states instructive. Avoid decorative microcopy or labels that add texture without understanding.

## Resist generated-design defaults

Treat these recurring patterns as warning signs, not bans:

- everything split into identical rounded cards;
- decorative gradients, glows, blur, shadows, or borders with no hierarchy/content role;
- one radius and surface treatment applied indiscriminately;
- tracked-out all-caps eyebrow labels above most headings;
- one emphasized italic/bold/accent-colored word becoming a repeated headline formula;
- small monospace metadata used mainly to look technical;
- arbitrary numbered markers where the content is not sequential;
- pill labels and controls used everywhere;
- one accent color washing across unrelated roles;
- hover lift, bounce, glow, or slide motion on nearly every control;
- familiar palette/type combinations chosen because they already look "designed".

The failure is not any individual ingredient; it is using the bundle without a reason. Spend visual boldness
selectively. Let a small number of memorable decisions carry identity and keep the surrounding system disciplined.

## Design stateful applications as systems

For application UI, do not optimize one ideal screenshot. Design the states and pressure conditions that materially
change hierarchy or usability as one system.

Account for both **width and height**. A layout that works at a narrow width can still fail in a short window, with a
software keyboard open, or when panels and overlays compete for space. Respond to available space, content needs, and
interaction priority rather than named devices.

Where relevant, check empty/populated, loading/error, disabled/busy, selected/focused, expanded/collapsed, long or
variable content, repeated items, secondary panels/drawers/popovers/overlays, low-height or software-keyboard pressure,
and pointer/touch/keyboard use.

Preserve existing functional and accessibility behavior unless the brief explicitly changes it. When space becomes
scarce, protect the primary task/content first and deliberately compress, regroup, overlay, defer, or progressively
disclose secondary chrome. Avoid adding nested surfaces or scroll regions merely to make everything fit; every extra
layer should have a clear content, interaction, or hierarchy reason.

Density is not a defect by itself. Expert tools may need compact, information-rich layouts; make density intentional and
scannable rather than automatically replacing it with oversized spacing or controls.

## Use motion to explain change

Motion should communicate causality, hierarchy, or focus. User-triggered transitions can help show what changed;
non-user-triggered motion should be rare. Do not animate every hover or section entrance.

Visible keyboard focus, reduced-motion behavior, readable contrast, and touch usability are a quality floor, not
optional polish.

## Build, render, critique, revise

Work in passes: plan and challenge generic choices; build one coherent version; render it with representative real
content and states; inspect it visually; critique it against the brief; revise and render again.

For a substantial redesign, perform at least two deliberate visual review passes. For complex applications, include
representative width, height, content, and interaction-pressure states. Source correctness does not substitute for
seeing the interface.

Ask during critique:

- Does the primary task or content read immediately?
- Are hierarchy and grouping understandable without decorative explanation?
- Does the visual language feel specific to this product?
- Is typography doing real hierarchy/identity work?
- Does secondary chrome consume more attention or space than it deserves?
- Do responsive and state changes feel like one system rather than emergency patches?
- Does variable content break the composition?
- Is motion communicating something useful?
- What can be removed without losing information, usability, or identity?

Continue revising while a material answer is unsatisfactory.
