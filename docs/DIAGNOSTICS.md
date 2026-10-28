# Diagnostics

Every code that a compiler diagnostic, runtime failure, developer warning, or checkpoint error carries is registered
once in `src/diagnostic-codes.ts`: the pass or component that reports it (its owner), its severity, a short title, and
the section that explains it. A rule that is an error where the compiler proves the problem and a warning where the
script checks it when it runs keeps one code with both severities, shown as `error or warning`. Code that reports a
diagnostic takes the registry's code types, so an unregistered code does not compile. `tests/diagnostic-codes.test.ts`
checks that every code in `src/` is registered and reported only by its owners, and that every registered code is still
reported or marked as retired. A retired code stays registered, so that it is never given to another problem.

This document lists the compiler's codes. The other runtime errors (`TSR`) are listed in
[Runtime errors](RUNTIME.md#runtime-errors), checkpoint errors (`TSK`) in
[Checkpoint boundary](RUNTIME.md#checkpoint-boundary), and each developer warning (`TSW`) in the section of its
feature.

One problem gets one code, whichever pass finds it
([One home for each language rule](review-and-audit/IMPLEMENTATION-AND-REVIEW.md#one-home-for-each-language-rule)),
also when the runtime finds it in a value the compiler did not know: then the runtime fails with the compiler's code
and text. The codes that more than one owner reports are listed in
[Codes with more than one owner](#codes-with-more-than-one-owner).

## Messages

A compiler diagnostic or runtime failure says what went wrong and why, naming the real operand or value, and what to do
about it, in whole sentences without semicolons, and quotes source in single quotes, as in `'total / count'` (owner
decision, 2026-10-09). It names its subject, such as the file, value, or place, instead of "it" or "this" (owner
decision, 2026-10-27). A sentence that authors read uses no implementation terms, such as "compiler", "follow", or
"store", unless they help the author fix the problem, and says "type", never "kind" (owner decision, 2026-10-27).
Where a whole number is required, a value of type `number` is "a number that can have decimals", and the message names
the line that brings them; elsewhere "a number" stays the general word (owner decision, 2026-10-27).

## Owners

- **lexer** (`src/lexer.ts`): the characters of the source.
- **parser** (`src/parser.ts` and `src/parser/`): the structure of the source, with the file header
  (`src/script-header.ts`) and the check that number and duration literals are finite.
- **name pass** (`src/semantic.ts` and `src/semantic/`): names, scopes, placement, and what the structure of a command
  allows.
- **type checker** (`src/type-checker.ts`): types and values. The coarse core (`src/type-inference/core/`), which
  replaces it, is reached only through a test-only compile route so far.
- **compiler** (`src/compiler.ts`): the project's file paths and images, the files the host could not load, waits
  written in days or weeks, the check of the compiled plan, and the host's call stack.
- **lowering** (`src/compiler/`): the instruction plan.
- **plan analysis** (`src/reachability.ts`, `src/speaker-flow.ts`): which code can run and how files and the session
  end, and which speaker properties a read can find, on the compiled plan.
- **plan validation** (`src/plan/`): the shape of an instruction plan, also one that a checkpoint brings.
- **runtime** and **checkpoint**: see [`RUNTIME.md`](RUNTIME.md).

## Lexer (TSL)

| Code | Title | Severity | Owner |
| --- | --- | --- | --- |
| `TSL001` | Invalid character | error | lexer |
| `TSL002` | Unknown escape sequence | error | lexer |
| `TSL003` | Unterminated string | error | lexer |
| `TSL004` | Unterminated block string | error | lexer |
| `TSL005` | Unterminated interpolation | error | lexer |
| `TSL006` | Invalid number | error | lexer |
| `TSL007` | Unterminated block comment | error | lexer |
| `TSL008` | Newline inside a single-line string | error | lexer |
| `TSL009` | Unterminated regex | error | lexer |

## Parser (TSP)

| Code | Title | Severity | Owner |
| --- | --- | --- | --- |
| `TSP001` | Expected a statement | error | parser |
| `TSP002` | Expected the end of the statement | error | parser |
| `TSP003` | Expected a speaker name after `speaker` | error | parser |
| `TSP004` | Expected a property, option, or key name | error | parser |
| `TSP005` | Expected `:` | error | parser |
| `TSP006` | Expected a string | error | parser |
| `TSP007` | Expected `}` | error | parser |
| `TSP008` | Expected an expression in `${...}` | error | parser |
| `TSP009` | Unsupported string or interpolation content | error | parser |
| `TSP010` | Expected a property name after `.` | error | parser |
| `TSP011` | Expected the end of a speaker property | error | parser |
| `TSP012` | Expected an expression | error | parser |
| `TSP013` | Expected a name | error | parser |
| `TSP014` | Expected `=` | error | parser |
| `TSP015` | Invalid assignment target | error | parser |
| `TSP016` | Expression that is not a statement | error | parser |
| `TSP017` | Expected a bracket, parenthesis, or separator | error | parser |
| `TSP018` | Expected a block | error | parser |
| `TSP019` | Positional argument after a named one | error | parser |
| `TSP020` | Chained comparison | error | parser |
| `TSP021` | Invalid type | error | parser |
| `TSP022` | Chained range | error | parser |
| `TSP023` | Expected `in` | error | parser |
| `TSP024` | Expected a function name | error | parser |
| `TSP025` | Expected a parameter | error | parser |
| `TSP026` | Empty parameter parentheses | error | parser |
| `TSP028` | Expected interaction text or an option value | error | parser |
| `TSP029` | Expected a speaker after `as` | error | parser |
| `TSP030` | Expected a choice option | error | parser |
| `TSP031` | Expected `,` after a choice option | error | parser |
| `TSP032` | Unsupported interaction form | error | parser |
| `TSP033` | Misplaced or invalid unit | error | parser |
| `TSP034` | Invalid timer form | error | parser |
| `TSP035` | Invalid media or permanent button form | error | parser |
| `TSP036` | Expected a storage key | error | parser |
| `TSP037` | Form from another language | error | lexer, parser, name pass |
| `TSP038` | Invalid switch form | error | parser |
| `TSP039` | Expected a label name or file path | error | parser |
| `TSP040` | Invalid load form | error | parser |
| `TSP041` | Unclear `otherwise` without parentheses | error | parser |

## File header (TSH)

The parser reads a file's header ([V30 file header](specifications/accepted-syntaxes-v30.md#file-header)).

| Code | Title | Severity | Owner |
| --- | --- | --- | --- |
| `TSH001` | Header without a closing line | error | parser |
| `TSH002` | Misplaced header | error | parser |
| `TSH003` | Expected a header field | error | parser |
| `TSH004` | Unknown header field | error | parser |
| `TSH005` | Repeated header field | error | parser |
| `TSH006` | Expected text | error | parser |
| `TSH007` | Interpolation in a header | error | parser |
| `TSH008` | Expected a tag | error | parser |
| `TSH009` | Invalid tag name | error | parser |
| `TSH010` | Invalid tag value | error | parser |
| `TSH011` | Repeated tag | warning | parser |
| `TSH012` | Tag with two different numbers, now `TST004` | error | parser |
| `TSH013` | Empty keyword | error | parser |
| `TSH014` | Repeated keyword | warning | parser |
| `TSH015` | Expected the end of the line | error | parser |
| `TSH016` | Expected a value | error | parser |

## Names, types, and values (TSV)

| Code | Title | Severity | Owner |
| --- | --- | --- | --- |
| `TSV001` | Protected name, or name already in use | error | parser, name pass |
| `TSV002` | Unknown variable | error | name pass |
| `TSV003` | Assignment to an unknown variable | error | name pass |
| `TSV004` | Assignment to a read-only name | error | name pass |
| `TSV005` | Unknown speaker | error | name pass |
| `TSV007` | Duplicate property or key | error | name pass, type checker |
| `TSV008` | `break` or `continue` outside a loop | error | name pass |
| `TSV009` | Chained range | error | name pass |
| `TSV010` | Invalid range bound or empty range | error | type checker |
| `TSV011` | Invalid wait, timer, repeat count, pacing, or timeout | error or warning | type checker |
| `TSV012` | Invalid `for` loop source | error or warning | type checker |
| `TSV013` | Duplicate function | error | name pass |
| `TSV014` | Duplicate parameter | error | name pass |
| `TSV015` | Required parameter after a default | error | name pass |
| `TSV016` | Nested function | error | name pass |
| `TSV017` | `return` outside a function | error | name pass |
| `TSV018` | Unknown function | error | name pass |
| `TSV019` | Call of a value that is not a function | error | name pass |
| `TSV020` | Wrong number or form of arguments | error | name pass, type checker |
| `TSV022` | Unknown named argument | error | name pass, type checker |
| `TSV023` | Argument given twice | error | name pass |
| `TSV024` | Missing argument | error | name pass |
| `TSV025` | Default that uses a later parameter | error | name pass |
| `TSV026` | Assignment to a function | error | name pass |
| `TSV028` | Function or built-in used as a value | error | name pass |
| `TSV029` | Invalid choice | error | type checker |
| `TSV032` | Blocking command in a parameter default | error | name pass |
| `TSV033` | Invalid timer or handler return | error | name pass |
| `TSV034` | Invalid timer handle member | error | type checker, runtime |
| `TSV035` | Duration combined with a number | error | type checker |
| `TSV036` | Invalid media file, option, or cue | error | type checker |
| `TSV037` | Invalid media handle member | error | type checker, runtime |
| `TSV038` | Invalid storage key | error | type checker |
| `TSV039` | Invalid prefill | error | type checker |
| `TSV040` | List where text is shown | error | type checker |
| `TSV041` | Type mismatch | error or warning | type checker, runtime |
| `TSV042` | Value that cannot be shown | error or warning | type checker, runtime |
| `TSV043` | Unsupported operand, method, or property | error or warning | type checker, plan analysis, runtime |
| `TSV044` | Mixed types | error | type checker |
| `TSV045` | Negative list index | error | type checker, runtime |
| `TSV046` | Test with a constant result | warning | type checker |
| `TSV047` | Invalid `case` value | error | name pass |
| `TSV048` | Repeated or overlapping `case` | error | name pass |
| `TSV049` | `case` that can never match | error | type checker |
| `TSV050` | Known values without a finite result | error | type checker |
| `TSV051` | Invalid label | error | name pass |
| `TSV052` | File end without `exit` or `end` | error | plan analysis |
| `TSV053` | Script that never reaches `exit` | error | plan analysis |
| `TSV054` | Variable that a `goto` may leave without a value | error | name pass |
| `TSV055` | Invalid start value | error | name pass, type checker |
| `TSV056` | Global function that uses names of its file | error | name pass |
| `TSV057` | Invalid file target | error | name pass, plan analysis |
| `TSV058` | Loop with no way out | warning | plan analysis |
| `TSV059` | Invalid camera view member | error | type checker, runtime |
| `TSV061` | Wait or timer written in days or weeks | warning | compiler |
| `TSV062` | Fallback that is never used | warning | type checker |
| `TSV063` | `speaker` without a speaker | error | name pass |
| `TSV064` | Invalid regex | error | name pass |
| `TSV065` | Code that never runs | warning | plan analysis |
| `TSV066` | `exit` that never runs | warning | plan analysis |
| `TSV067` | Change of a copy that no variable holds | error | type checker |
| `TSV068` | Invalid timer display | error | type checker |
| `TSV069` | Blocking media handle, or `finish` twice | error | name pass |
| `TSV070` | `end` with no call to return to | error | plan analysis |
| `TSV071` | `end` that may have no call to return to | warning | plan analysis |
| `TSV072` | `call` of the running file | error | plan analysis |
| `TSV073` | `call` that may start the running file | warning | plan analysis |
| `TSV074` | `goto` that may lead to a file of declarations only | warning | plan analysis |
| `TSV075` | Union with a whole list, set, or dict beside another type | error | type checker |

## Tags (TST)

| Code | Title | Severity | Owner |
| --- | --- | --- | --- |
| `TST001` | Invalid tag query | error | parser |
| `TST002` | Tag query that matches nothing | error | type checker |
| `TST003` | Image keywords that are not tags | warning | compiler |
| `TST004` | Tag with two different numbers | error | parser, compiler, type checker |
| `TST005` | Invalid tag | error | type checker |
| `TST006` | Invalid `from:` of a tag query | error | type checker |
| `TST007` | Image tags that could not be read | warning | compiler |

## Compiler (TSC)

| Code | Title | Severity | Owner |
| --- | --- | --- | --- |
| `TSC001` | Literal that is not finite | error | parser |
| `TSC002` | Malformed instruction plan | error | plan validation |
| `TSC003` | Lowering failure | error | lowering |
| `TSC006` | Compiled plan rejected by plan validation | error | compiler |
| `TSC007` | Host call stack exhausted | error | compiler |
| `TSC008` | Invalid presentation option or markup colour | error | type checker |
| `TSC009` | Invalid or repeated package path | error | compiler |
| `TSC010` | Unsupported instruction plan format or revision | error | plan validation |
| `TSC011` | Package file that could not be loaded | error or warning | name pass, compiler |

## Codes with more than one owner

A shared code is one problem that each owner finds in another place and reports with the same text. Two problems need a
code each.

- `TSP037`
  - lexer: a symbol of another language that is no token, as `;`, with the text of `FOREIGN_FORMS`
  - parser: the same rule with the same text for a symbol that is a token, such as `&&`, a word that starts a statement, such as `def`, an `f` that touches text, a loop head in parentheses, and a `:` that ends the line before a block, each where the source fails without it
  - name pass: the same rule with the same text for a name that no declaration takes, such as `None` or `print(...)`
- `TSV001`
  - parser: a declaration whose name is a keyword or another protected name, where it reads the name
  - name pass: the same rule with the same text (`protectedNameMessage`) where it finds such a declaration, and a name that is already in use
- `TSV007`
  - name pass: a property name that a speaker declaration or an object literal gives twice (`duplicateEntryMessage`)
  - type checker: the same rule with the same text for a key that a dict literal gives twice, also through a computed key whose text is known
- `TSV020`
  - name pass: calls of the script's functions and of the commands it knows by name, such as `load` without `default:`, `askImage`, `showPopup`, `openUrl`, `exportText`, and `takePhoto`, with the messages of `argument-rules.ts`
  - type checker: the same rules with the same texts for method calls, `script(...)`, the functions of the current date and time, and the other built-ins
- `TSV022`
  - name pass: calls of the script's functions and of the commands it knows by name (`unknownNamedArgumentMessage`)
  - type checker: the same rule with the same text for method calls, `script(...)`, and the other built-ins
- `TSV034`, `TSV037`, `TSV059`
  - type checker: a member that a timer handle, media handle, or camera view does not have, a property it cannot assign, and a value outside a property's domain (`handle-members.ts`)
  - runtime: the same rules with the same texts for a property it cannot assign and a value outside a property's domain, where the handle is not known when the script is compiled
- `TSV041`
  - type checker: every value that does not fit its place, among them a handle property of another type (`assignedTypeMessage`)
  - runtime: the same rule with the same text for a handle property, where the handle is not known when the script is compiled
- `TSV042`
  - type checker: every value that text cannot show, among them in `${...}` and `join()` (`shown-text-rules.ts`)
  - runtime: the same rules with the same texts for `${...}` and `join()` of a value whose type the compiler does not know
- `TSV043`
  - type checker: every operation that its operands do not support, among them a speaker property that no declaration or assignment gives a speaker the read may reach (`missingSpeakerPropertyMessage`)
  - plan analysis: the same rule with the same text for a speaker property that a way to the read misses (V30 §37)
  - runtime: the same rules with the same texts for a value whose type or value the compiler does not know: a built-in's argument of another type, among them the text of `text-operand-rules.ts`, the options of `lock-rules.ts`, `toJson`, the numeric and list functions, the arguments of a text or list method, a `save` of a value that exists only in the session (`save-rules.ts`), and a property of a message handle or a permanent button that cannot be assigned
- `TSV045`
  - type checker: a list index that the compiler knows is below 0 (`negativeListIndexMessage`)
  - runtime: the same rule with the same text for an index it does not know
- `TSV055`
  - name pass: a start value that says, asks, waits, plays media, calls a function, or uses a local or a later global (`startValueMessage`)
  - type checker: the same rule with the same text for a start value that selects at random, with `.random` or a list in `${...}`, which needs the value's type
- `TSV057`
  - name pass: a file target that names no file the `goto` or `call` can start, among them a `goto` to a file of declarations only, by its path or a `script(...)` of its path written out (`declarationsOnlyMessage`)
  - plan analysis: the same rule with the same text for a computed `goto`, such as `goto (next)`, when the references of the project can name only one file and it holds declarations only
- `TST004`
  - parser: a tag that a file header gives two different numbers (`conflictingTagMessage`)
  - compiler: the same rule with the same text, naming the image, for the keywords of an image
  - type checker: the same rule with the same text for the written tags of `takePhoto(tags: [...])`
- `TSC011`
  - name pass: a path or glob written out that names a file the host could not load, or may name a file in a folder it could not read, as the target of a `goto` or `call`, in `script(...)`, as the `from:` of a tag query, or as the file of `showImage`, `playAudio`, or `playVideo`, with the host's reason as its text
  - compiler: the same rule with the same text for `main.tease`, where every session starts, and as a warning at each other file or folder the host could not load that no such path or glob names
