# ADR 0022 — Multi-file scripts: goto and call across files, globals, and explicit endings

**Status:** Accepted
**Decision source:** Owner decisions in issue #570 (2026-10-04)

## Context

V30 let a package hold several `.tease` files, but connected them through `run`, which abandoned the current file and
let an engine-owned script-selection flow pick the next file when a `run` file reached `end`. That rotation was
invisible in the source, and V30 had no variables shared between files. Imported legacy scripts need explicit jumps,
calls, and shared state between files.

## Decision

### 1. Project

1. A package is one project of `.tease` files. Its fixed entry file is `main.tease`, and a session starts at its top.
2. Paths are relative to the package root and separate folders with `/`; a path that leaves the package is an error.
3. All files compile together before play into one plan. One snapshot and one checkpoint hold the state of all files.

### 2. Targets

```tease
goto intro                                    // label in this file
goto "punishments/strict.tease"               // another file, from its top
goto "punishments/strict.tease" start         // another file, at a label
goto "punishments/*.tease"                    // a random file from the glob
goto "punishments/*.tease" start              // a random file among those that have label start
call "corner-time/*.tease"                    // the same targets; returns when the file ends
goto script("rooms/${room}.tease")            // dynamic: an explicit conversion, validated at runtime
goto script("rooms/${room}.tease", label: "start")
```

1. `goto` and `call` accept the same targets. A missing file or label is a compile error.
2. A glob uses `*` for any characters within one folder or file name. Globs are expanded at compile time. With a label,
   the pick is among the matched files that have that label. It is a compile error only when the glob matches nothing,
   or no match has the label.
3. Each time a glob target runs, one draw from the session random generator picks the file. Restoring a checkpoint
   never draws again.
4. `script(path, label:)` returns a script reference, of type `script`. Plain text is not a jump target. References can
   be stored in lists, dicts, and globals. A bare variable as a target is grouped: `goto (next)`. A missing file or label
   is a compile error when known, otherwise a runtime error.
5. `run` is removed. There is no automatic rotation or category selection; composition logic is visible in the script.

### 3. Labels and file-local names

1. A label stands only in a file's outer scope, not inside `if`, loops, functions, or handlers. A `goto` may appear
   anywhere.
2. Functions and labels are local to their file. Two files may use the same function or label names.

### 4. Endings

1. `exit` is the only normal way to finish the session.
2. `end` ends the current file and returns to the file that `call`ed it.
3. A reachable end of a file without `end`, `exit`, or a transfer is a compile error, with a friendly message. Branches
   that all end or transfer need nothing extra.
4. Reaching `end` or the end of a file with no caller is an error, unless the author explicitly declared a fallback
   destination, such as a menu script; execution then continues there. The fallback is never implicit. Its syntax is
   still being designed and will be recorded here when accepted.

### 5. Transfers

1. `goto` to another file replaces the current file and keeps the pending `call` returns. It discards the current
   function, loop, and block continuations, as a `goto` within a file does.
2. `call` preserves them and resumes after the `call` when the called file reaches `end`.
3. A handler that jumps abandons the interrupted action.
4. Asynchronous media continues across `goto`, `call`, and `end`. `exit` stops it.
5. Timers and permanent buttons follow V30 §27 and §28: on `goto`, `call`, and `end`, non-persistent ones are removed and
   persistent ones stay; `exit` removes all.

### 6. Globals

```tease
global strictness = 2
global level = load "level", default: 1
```

1. A `global` is declared at the top level of any file, at any position, not inside `if`, loops, functions, or handlers.
2. It is visible in all files. Global names are unique in the project, and no other name may shadow one.
3. Globals are initialized once at session start, before the story runs, in a deterministic order: `main.tease` first,
   then the other files in path order, each in source order. An initializer that reads a global initialized after it
   is a compile error.
4. Initializers may use literals, earlier globals, side-effect-free operators, and `load … , default:`. They may not use
   interactions, calls, or random numbers.
5. Types follow the `let` rules of ADR 0021, applied across all files.
6. Values are checkpointed and live for the session. `save` and `load` give persistence beyond it.

## Consequences

- Plans, snapshots, and checkpoints record which file each position, frame, and call return belongs to.
- Scripts that relied on `run` or rotation are rewritten with explicit `goto`, `call`, and globs.
- Tag-based selection (`goto tagged …`, `findScripts`) is a separate decision that builds on these targets.

## Alternatives considered

- Keeping `run` with engine rotation: less to write, but the flow between files is hidden from the author.
- Requiring every file of a glob to have the requested label: catches typos, but forces placeholder labels into files
  that do not take part.
- Plain text as a jump target: one form less, but a text meant as an image path or message could be passed by mistake,
  and a typo is found only when that path runs.
- Globals only in `main.tease`: one place to read them, but shared state cannot sit next to the file that uses it.
- Paths relative to the calling file: easier to move a folder, but the same path would mean different files in
  different places.
