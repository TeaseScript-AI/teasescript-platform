# Legacy SexScript analysis

## Conclusion

SexScript should be migrated as a domain-specific legacy platform, not as arbitrary Groovy-to-TypeScript source.

The source files are genuine Groovy, but SexScript wraps each file inside the body of a generated `run()` method on a
runtime class. Most author-facing behavior comes from inherited SexScript methods. The practical importer therefore
needs a real Groovy parser for syntax fidelity, followed by SexScript-aware semantic analysis and lowering to normal
TeaseScript.

A generic Groovy-to-TypeScript transpiler would preserve the wrong execution model: JVM objects, Java APIs, reflection,
mutable reference identity, blocking threads, OS access, and live call-stack assumptions do not belong in the
TeaseScript runtime.

## Execution model found in the source

Desktop SexScript uses a template equivalent to:

```groovy
class FullScript_NAME extends ss.desktop.Script {
    String run() {
        if (loadInteger("NAME.launch.firsttime") == null)
            save("NAME.launch.firsttime", getTime())
        save("NAME.launch.lasttime", getTime())
        if (loadInteger("NAME.launch.nb") == null)
            save("NAME.launch.nb", 0)
        save("NAME.launch.nb", loadInteger("NAME.launch.nb") + 1)

        // Original .groovy source is inserted here.

        return null
    }
}
```

The generated wrapper matters to parsing. A legacy file is effectively a Groovy method-body fragment, not an
independent Groovy `Script` with an unrestricted top-level declaration model. For example, a normal Groovy method
declaration may parse as a standalone script but is invalid when inserted inside `run()`; closures remain available.

The desktop distribution contains Groovy 2.5.21. The Android implementation uses Groovy/Grooid 2.4.16. The bundled
scripts were successfully parsed with both legacy parser versions during the initial research. Parsing can stop at the
AST conversion phase and does not require executing user code.

SexScript also performs a textual rewrite of `wait(` calls to an inherited `replacedByWait(...)` method before
compilation. An importer needs to understand the effective legacy behavior, but should not copy this textual mechanism.

## SexScript-specific surface

The API interface in the old source exposes these main groups.

### Interaction and display

- `show(message)`
- `showButton(message)`
- `showButton(message, duration)`
- `showPopup(message)`
- `getBoolean(text)` and custom yes/no labels
- `getBooleans(title, values, defaultValues)`
- `getSelectedValue(text, values)`
- `getString(text, defaultValue)`
- `getInteger(text, defaultValue)`
- `getFloat(text, defaultValue)`
- `getFile(message)`
- `getImage(message)`

### Time and random

- `getTime()`
- `getRandom(max)`
- `wait(...)` through the legacy rewrite
- `waitWithGauge(...)`

### Local state

- `save(key, value)`
- `load(key)`
- `loadString`, `loadInteger`, `loadFloat`, `loadBoolean`, `loadMap`
- `loadFirstTrue(...)`

Values are persisted through Java `Properties`. Lists and maps are flattened into dotted keys and generic `load()`
reconstructs values by parsing scalar strings and discovering indexed/map children. This should be migrated to native
TeaseScript typed persistence, not emulated permanently.

### Media and platform helpers

- `setImage(fileName)` and byte-array image output
- `playSound(fileName)`
- `playBackgroundSound(fileName[, times])`
- `stopSoundThreads()`
- `useUrl(url)`
- `useFile(fileName)`
- `useEmailAddress(address)`
- `openCdTrays()`
- `getDataFolder()`

Some of these have clean modern equivalents. Others are host/OS capabilities and require a warning or deliberate
replacement rather than automatic compatibility emulation.

### Old remote data service

The API also contains `send`, `receive*`, `sendImage`, `receiveImage`, and `isConnected`. These refer to the old
SexScript online service. They should not become a generic network escape hatch in TeaseScript.

### Metadata and chaining

`setInfos(...)` supplies script metadata. Returning a non-null script name from `run()` asks the host to locate and
execute another SexScript. A null/empty script-level return ends the current chain; `exit()` exits the application.

The importer can map static metadata into package metadata and map ordinary script chaining to TeaseScript content
transfer. It must distinguish this from a normal function return.

## Plain Groovy behavior actually available

Because the source is compiled as Groovy, scripts are not limited to the documented SexScript API. The bundled source
uses or demonstrates:

- `def` variables and dynamic typing;
- `if`/`else`, `for`, `while`, `return`, `try`/`catch`;
- lists, maps, indexing, property access, collection methods, and `.each { ... }` closures;
- casts, generics, constructors, default-import Java classes, and method chaining;
- `System` access, `Class.forName`, reflection, AWT, and Android graphics.

The bundled `test.groovy` is particularly useful as an adversarial fixture because it deliberately mixes ordinary
SexScript flow with reflection, platform detection, remote-service calls, and programmatic image generation.

## Important semantic mismatches

### Dynamic `def` types

A Groovy `def` binding may hold values of unrelated types over its lifetime. TeaseScript bindings use stable accepted
types. The importer therefore needs type-flow analysis; a syntax-only rewrite can produce invalid or incorrect output.

### Mutable alias identity

Groovy lists and maps are mutable reference objects. For example:

```groovy
def a = [1]
def b = a
b.add(2)
```

`a` observes the mutation. Accepted TeaseScript value semantics deep-copy ordinary composite values on declaration,
assignment, list-element capture, and object-field capture. Alias-dependent legacy code therefore needs detection and
cannot be silently rewritten as ordinary TeaseScript.

### Blocking host methods versus resumable runtime behavior

Legacy methods block Java/Groovy execution while waiting for user input, time, or media. TeaseScript represents
resumable behavior as deterministic serializable engine state. The importer must translate the intent to TeaseScript
instructions/Standard Library behavior rather than preserve the old call stack.

### UI semantics

Legacy `show()` replaces a single main text area. A normal TeaseScript `say` contributes to a chat/transcript model.
That may be an acceptable migration choice for many scripts, but it is a visible semantic difference and should be
tracked explicitly rather than called an exact mapping.

## Mapping

Legacy semantics below are verified against the API contract (`ss/IScript.java`) and desktop implementation
(`ss/desktop/Script.java`, `PropertiesWorker`) of the SexScript source. Input functions show their text exactly like
`show()` before asking; a `null` text keeps the current text.

| Legacy SexScript | Generated TeaseScript | Notes |
| --- | --- | --- |
| `show(x)` | `say x` | `show` replaced the text area; `show(null)`/`show()` only cleared it and are dropped. |
| `showButton(label)` | `showButton label` | Legacy default timeout was 30 days. |
| `showButton(label, s)` / its result | `showButton label, timeout: s` / `(showButton label, timeout: s) / 1 s` | Compact timeout form (#531, implemented in #534); the elapsed result is a duration, legacy returned seconds. |
| `showPopup(x)` | `showPopup x` | Accepted, not implemented yet; a used elapsed result is measured with `getTimestamp().toSeconds()`. |
| `getBoolean(text[, yes, no])` | `say text` + `(choose yes: ..., no: ...) == "yes"` | First button means true; default labels Yes/No. |
| `getSelectedValue(text, [a, b])` | `say text` + `choose 0: a, 1: b` | Numeric values return the zero-based index. A runtime list becomes `{ value, text }` choice objects (PR #515). |
| `getString` / `getFloat` | `say text` + `askText default: d` / `askNumber default: d` | A null or blank default fails when the input opens; legacy showed it. Cancel-to-null is lost. |
| `getInteger(text, d)` | `say text` + `askInteger default: d` | Compact integer input (#548); a null default fails when the input opens. |
| `getImage(text)` | `takePhoto()` | Camera only (V30 §33, not implemented yet); the legacy file-chooser fallback is dropped. |
| `getBooleans(t, values, defaults)` | `askBooleans(message:, texts:, defaults:)` | Accepted, not implemented yet. |
| `getRandom(max)` | `randomInteger(0..max)` | Exclusive upper bound; `list[getRandom(list.size())]` becomes `list.random`. |
| `getTime()` | `getTimestamp().toSeconds()` | Unix seconds (#532); TeaseScript `getTime()` is a time-of-day value. |
| `wait(s)`, `sleep(ms)` | `wait s`, `wait ms ms` | |
| `waitWithGauge(s)` | `timer s` | Gauge styling is presentation. |
| `save(k, v)` / `save(k, null)` | `save v as k` / `delete k` | Legacy `save` also removed dotted sub-keys `k.*`. |
| `loadString(k)` etc. | `load k` | Owner semantics: `null` when missing, no write. A typed read followed by `if (x == null) x = d` becomes `load k, default: d` (#541); other defaults stay explicit null checks. A condition `loadBoolean(k)` becomes `(load k) == true`. |
| `setImage(f)` / `setImage(null)` | `showImage f` / `hideImage` | Byte-array images and video files need manual work. |
| `playSound(f)` | `playAudio f` | Blocking. `playSound(null)` stopped every sound. |
| `playBackgroundSound(f[, n])` | `playAudio async f` / with `repeat: n times` | Legacy plays `n` passes total and overlaps; `null` stops all sounds (no TeaseScript equivalent). |
| `useUrl(u)` | `openUrl(u)` | Accepted, not implemented yet. |
| `setInfos(...)` | header comment | No accepted manifest format yet. |
| returned script name / `return null` | `run "x.tease"` / `end` | A final `return null` is dropped; chaining is not a function call. |
| `exit()`, `System.exit(n)` | `exit` | Ends the session; the Player stays open. |

## Parser recommendation

Use a real Groovy parser as an import-only frontend. The initial research showed that the exact bundled Groovy 2.5.21
parser can parse the bundled corpus to an AST without running the scripts. It should be isolated from the Player and
normal TeaseScript runtime.

A practical parser protocol is:

```text
Groovy source + virtual filename + wrapper metadata
  -> parser helper
  -> JSON AST with explicit node kinds and source spans
```

The TypeScript importer can then classify SexScript calls, perform type/alias/portability analysis, and lower to a
parser-neutral migration IR. This keeps a future parser replacement possible without changing the core migration
logic.

A modern Groovy grammar or tree-sitter frontend may later replace the legacy parser if it can be proven against the
compatibility corpus. That should be an optimization after the legacy semantics are characterized, not the starting
assumption.

## `.ts` helper boundary

Generated TypeScript is appropriate only for deterministic synchronous portable logic that naturally belongs in a
TeaseScript package library. It is not a fallback target for arbitrary Groovy.

Good candidates can include a complex pure transformation or a deliberate Canvas implementation of recognized drawing
intent. Reflection, arbitrary JVM access, filesystem/process control, threads, unrestricted networking, or platform
object identity should instead produce migration diagnostics/manual work.

Waits, interactions, timers, blocking media, and any behavior that must survive checkpoint/restore belong in normal
TeaseScript/runtime-managed behavior, not an invisibly suspended TypeScript call.

## Recommended migration pipeline

1. Discover legacy scripts, localized variants, package resources, and optional persisted state.
2. Reconstruct the effective SexScript wrapper/preprocessing context without executing user code.
3. Parse Groovy and emit a stable source AST with spans.
4. Classify SexScript runtime intrinsics separately from ordinary Groovy/Java calls.
5. Analyze types, nullability, aliases/mutations, closures, maps, platform calls, and resource paths.
6. Lower the supported majority into a SexScript-oriented migration IR.
7. Emit readable `.tease` from the IR.
8. Generate narrowly scoped `.ts` helpers only for portable deterministic logic.
9. Emit structured diagnostics for unsupported or behavior-changing cases.
10. Compile generated packages and compare deterministic traces/observable decisions against legacy fixtures where a
    safe legacy reference execution is available.

## Initial real-script corpus

Besides the scripts bundled with the player, two user-provided sources are available as external corpus material:

- `Domme3_1661588844.zip` contains `scripts/Domme3.groovy` and a substantial `scripts/Domme3/*.groovy` tree.
- `Discipline.tar.gz` contains several historical packages; `DisciplineClinic_1748833969.zip` contains a multi-script
  `scripts/DisciplineClinic/` tree.

These archives and their media remain external test inputs and are not committed to Git.
