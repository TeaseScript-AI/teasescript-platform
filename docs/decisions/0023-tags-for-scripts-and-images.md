# ADR 0023 — Tags for scripts and images: file headers, tagged selection, and XMP image tags

**Status:** Accepted
**Decision source:** Owner decisions in issue #572 (2026-10-04)

## Context

Authors pick a random script or image by what it shows: a punishment module, a bedroom photo. Legacy tease apps encode
this in folder names. ADR 0022 gave projects explicit file targets, but files had no metadata, and images had no
author-visible tags.

## Decision

### 1. File header

```tease
---
title: "Strict punishment"
author: "Mistress X"
description: "Corner time with lines, for after a failed task."
tags: "chastity", punishment: 4
keywords: "chastity", "femdom", "long session"
---
say "Your punishment begins."
exit
```

1. Every file may start with a header between two `---` lines, with one `field: value` per line and values written as
   TeaseScript literals. It is not YAML: indentation has no meaning, and nothing in it executes or reads variables.
2. `title`, `author`, and `description` are shown on the website and in an editor overview of many files.
3. `tags` drives selection inside the package. `keywords` (main file) feeds the future website catalog search and never
   affects selection.
4. The header leaves room for later catalog fields, each needing its own decision: sex toys marked absent, optional, or
   required; kinks rated by the author and matched against the player's own ratings; body or gender requirements.

### 2. Tags

1. Tag names use lowercase ASCII letters, digits, and hyphens. Input is normalized (`Punishment` → `punishment`). `:`
   is reserved for the number.
2. A tag may carry a number: `punishment: 4`. A valued tag also counts as present. A tag without a number makes
   numeric comparisons false.

### 3. Selection

```tease
showImage tagged "bedroom", "punishment"                        // comma = and
goto tagged "punishment", none: ["intense"]
goto tagged "punishment" > 3 and not "public"                   // valued tag comparison
showImage tagged ("bedroom" or "bathroom") and not "outdoor"
call tagged "chastity", from: "modules/*.tease"
```

1. Inside `tagged`, a quoted name tests presence, and a quoted name followed by a comparison reads that tag's number.
2. `and`, `or`, `not`, and parentheses work as in conditions. The right-hand side of a comparison is an ordinary
   expression, so `"punishment" > minimum` reads the script variable `minimum`.
3. Selection draws from the session random generator, and catalogs are checkpointed, so restoring never draws again. An
   account or local image catalog is frozen per session.

### 4. Lists for counting and custom logic

```tease
let pool = findScripts(from: "modules/*.tease", where: "punishment" > 3)
if pool.length > 0 { goto (pool.random) } else { goto "fallback.tease" }
let photos = findImages(where: "bedroom" and "punishment")
```

1. `findScripts` returns script references (ADR 0022). `findImages` returns image references, which are text.
2. A directly selected query that provably matches nothing in the package is a compile error, under the conditions in
   [V30 §41](../specifications/accepted-syntaxes-v30.md#tagged-selection). A query used as a list may be empty.

### 5. Image tags

1. Image tags live in the image file itself as XMP keywords, an open standard (ISO 16684-1). Formats or tools that cannot
   embed use an `image.jpg.xmp` sidecar. A valued tag is the keyword `punishment: 4`.
2. The catalog the engine uses is generated from the images and never hand-edited, so losing it loses no tags.
3. The editor gets a tag UI that writes these keywords, so beginners never see XMP. Tags from Lightroom, digiKam,
   darktable, Windows Explorer, or Apple Photos exports carry over, because these tools write the same keywords. Folder
   names can be mapped to tags once, explicitly, at import.
4. During development a temporary server folder is scanned. Laravel stores uploaded images and their extracted tags
   later.
5. Private photos stay on the player's device unless the player consents to upload. A script can tag a photo when it is
   taken: `let photo = takePhoto(tags: ["bedroom", "punishment: ${level}"])`.

## Consequences

- Header metadata never reaches the instruction stream. Script tags enter the plan with the script catalog; image tags
  enter it as a generated image catalog.
- The canonical specification gains each part when it is implemented: V30 §41 holds the header and tag rules, and later
  parts add tagged selection, the list functions, and image tags there.
- Per-player encryption of uploaded private photos is a later decision.

## Alternatives considered

- A `metadata { tags: [...] }` block: no new delimiter, but it reads like JSON and hides the boundary between metadata
  and the script.
- YAML front matter: familiar, but unquoted strings and indentation would mean something different from the TeaseScript
  below it.
- A separate numeric field such as `tagValues: { intensity: 4 }`: typed, but one tag would then live in two places with
  two spellings.
- A hand-edited `assets.json` as the only home of image tags: simple, but losing the file loses every tag.
- Hand-numbered tags such as `punishment1` to `punishment4`: no numbers needed, but no comparisons either.
