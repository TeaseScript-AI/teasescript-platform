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
2. A glob uses `*` for any characters within one folder or file name. Globs are expanded at compile time. A glob only
   picks files that do something: the matched files that have the label, when one is given, and do not hold
   declarations only. It is a compile error only when no such file remains.
3. Each time a glob target runs, one draw from the session random generator picks the file; a glob `fallback` draws
   each time the fallback is used. Restoring a checkpoint never draws again.
4. `script(path, label:)` returns a script reference, of type `script`. Plain text is not a jump target. References can
   be stored in lists, dicts, and globals. A bare variable as a target is grouped: `goto (next)`. A missing file or label
   is a compile error when known, otherwise a runtime error. A reference names its file by path, so it keeps its meaning
   when saved; a transfer checks it when it runs, and a computed `fallback` when the statement runs.
5. `run` is removed. There is no automatic rotation or category selection; composition logic is visible in the script.

### 3. Labels, file-local names, global functions, and speakers

1. A label stands only in a file's outer scope, not inside `if`, loops, functions, or handlers. A `goto` may appear
   anywhere.
2. Functions and labels are local to their file. Two files may use the same function or label names. A regular function
   may read its file's top-level `let`s and is callable only from its own file.
3. A `goto` back to an earlier label runs the top-level `let`s after it again, which set their variables anew.
4. A variable of the file may be used after a label only when every way to the label has run its `let`; otherwise it
   is a compile error. A goto has run what came before the statement it stands in, or before the call of its function
   or the start of its handler. The ways are those of the ending check (§4.3), so a goto that cannot run is no way; a
   transfer that enters a file afresh at a label has run nothing of that file before it. Whether code can run is
   decided per statement and per function or handler context: a statement that can run, in the file's top level, in
   a function that a call which can run reaches, or in a block started where code can run. A call in such a statement
   counts, even in an operand that a constant `and` or `or` skips, or in a parameter default that every call supplies.
   Globals and speakers are not variables of a file: they have their values from the start of the session (§6).
   Which labels a `script(...)` reference may enter, the compiler reads from the source alone, by whether its path and
   label are literal text (V30 §29), where the reference can run; other early uses, such as after a label that a
   reference from `load` entered, are runtime errors when they run.
5. A `global function` is callable from every file, without an import:

   ```tease
   // helpers.tease
   global function punish(count) { ... }
   // chapter1.tease
   punish(3)
   ```

   It may use only globals, its parameters, and its own locals, not its file's top-level `let`s, and may call only
   other global functions and built-ins. Breaking either rule is a compile error whose fix is to make the name a global
   or pass it as a parameter. Interactions, `goto`, `call`, `end`, `exit`, and recursion work in it normally; a bare
   label means a label of the file where the function is written, like `goto "helpers.tease" start`. Such a goto
   enters that file afresh, so for rule 4 none of its top-level `let`s has run there.

6. Speakers are always global: `speaker vera { … }`, declared anywhere in any file, is known in every file and is set up
   at session start under the rules for globals (§6). There is no `global speaker`. `speaker vera`, which sets the
   default speaker, stays an ordinary statement.
7. Globals, global functions, and speakers are unique across the project. A regular function, `let`, parameter, or
   host-provided global with the same name anywhere is a compile error.

### 4. Endings

1. `exit` is the only normal way to finish the session, and it is always required, in `main.tease` too: the author marks
   the end of a script deliberately. A project with no reachable `exit` does not compile.
2. `end` ends the current file and returns to the file that `call`ed it.
3. A reachable end of a file without `end`, `exit`, or a transfer is a compile error in every file, with a friendly
   message. Branches that all end or transfer need nothing extra, and loops and recursion are fine. A file of
   declarations only (functions, global functions, speakers, and globals without `default:`) runs nothing on its own,
   so it needs no ending; a `goto` into such a file is a compile error.
   The compiler follows the statements, with constant conditions, loops that certainly run once or never,
   `while true`, and branches that all end; a call counts as returning, also of a function that always ends the
   session, so the ending after such a call is still written out.
4. Reaching `end` with no caller continues at the fallback destination when one is set, and is an error otherwise. The
   fallback is never implicit.
5. `fallback` sets the fallback destination. It takes the same target forms as `goto`:

   ```tease
   fallback "menu.tease"
   fallback "menu.tease" start
   if chapter > 3 { fallback script("chapters/${chapter}.tease", label: "recap") }
   ```

   It may run any number of times, anywhere, including inside `if`; the latest one executed wins. It is session state
   and is checkpointed, not metadata. `fallback none` clears it again.

### 5. Transfers

1. `goto` to another file replaces the current file and keeps the pending `call` returns. It discards the current
   function, loop, and block continuations, as a `goto` within a file does.
2. `call` preserves them and resumes after the `call` when the called file reaches `end`.
3. A handler that jumps abandons the interrupted action.
4. Asynchronous media continues across `goto`, `call`, and `end`. `exit` stops it.
5. A non-persistent timer or permanent button belongs to the file entry that started it and goes when that entry is
   left: by a `goto` from it, by its `end`, or when a block's `goto` abandons it. A `call` does not leave the caller.
   Persistent ones stay; `exit` removes all (V30 §27, §28). A block that stays keeps the local variables it shares
   (ADR 0024), although the continuations that declared them are discarded.
6. Each entry into a file has its own top-level variables. V30 §29 states how functions, blocks, `end`, and a block's
   `goto` relate to entries.

### 6. Globals

```tease
global strictness = 2
global level = load "level", default: 1
```

1. A `global` may be declared anywhere in any file, including inside `if`, loops, functions, and timer and media
   blocks. Declarations are collected at compile time and initialized at session start, whether or not the surrounding
   block ever runs, so an initializer cannot use local values. Reaching the declaration later does nothing, except in
   the `default:` form of rule 5.
2. It is visible in all files. Global names are unique in the project (§3.7), and no other name may shadow one.
3. Globals and speakers are initialized once at session start, before the story runs, in a deterministic order:
   `main.tease` first, then the other files in path order, each in source order. An initializer that reads a global
   initialized after it is a compile error.
4. Initializers, including speaker properties, may use literals, earlier globals, side-effect-free operators, and
   `load … , default:`; a `script(...)` reference counts as a literal, with arguments under the same rules. They may
   not use local values, interactions, other calls, or random numbers, including the random element that `.random` or
   a list in `${...}` selects. Nested and lazy parts, such as a `load` default, follow the same rules.
5. With `default:`, the global gets the `default:` value at session start, and the declaration assigns its initializer,
   which may be any expression, each time it runs:

   ```tease
   function practice {
       let localCount = askInteger "How many did you do?"
       global attempts = localCount, default: 0
   }
   ```

   The `default:` value follows rule 4. A `, default:` belongs to the nearest construct before it that takes one, so
   `global level = load "level", default: 1` gives the default to `load`. Without `default:`, an initializer that uses
   a local value is a compile error that names the global, explains that it needs a value from the start of the session,
   and shows both fixes: adding `, default: 0`, or writing `global attempts = 0` and later `attempts = localCount`.

6. Types follow the `let` rules of ADR 0021, with one type environment for all files; ADR 0021 rule 6 gives the
   checking order across files. When the project holds a file `call`, what is known about a global that some file's
   top level assigns does not outlast a file or function call; when some file holds a `goto`, `call`, or `fallback`
   that may enter `main.tease` at its top (a glob that may pick it or a computed target counts), `main.tease` starts
   without what its start values stored. Both rules look at the source as written, including code that cannot run.
7. Values are checkpointed and live for the session. `save` and `load` give persistence beyond it.

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
