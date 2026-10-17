# Diagnostics

Every code that a compiler diagnostic, runtime failure, developer warning, or checkpoint error carries is registered
once in `src/diagnostic-codes.ts`: the pass or component that reports it (its owner), its severity, a short title, and
the section that explains it. Code that reports a diagnostic takes the registry's code types, so an unregistered code
does not compile. `tests/diagnostic-codes.test.ts` checks that every code in `src/` is registered and reported only by
its owners, that every registered code is still reported or marked as retired, and that the tables below match the
registry. A retired code stays registered, so that it is never given to another problem.

This document lists the compiler's codes. Runtime errors (`TSR`) are listed in
[Runtime errors](RUNTIME.md#runtime-errors), checkpoint errors (`TSK`) in
[Checkpoint boundary](RUNTIME.md#checkpoint-boundary), and each developer warning (`TSW`) in the section of its
feature.

One problem gets one code, whichever pass finds it
([One home for each language rule](review-and-audit/IMPLEMENTATION-AND-REVIEW.md#one-home-for-each-language-rule)).
The codes that more than one owner reports are listed in
[Codes with more than one owner](#codes-with-more-than-one-owner).

## Owners

- **lexer** (`src/lexer.ts`): the characters of the source.
- **parser** (`src/parser.ts`): the structure of the source, with the file header (`src/script-header.ts`) and the
  check that number and duration literals are finite.
- **name pass** (`src/semantic.ts`): names, scopes, placement, and what the structure of a command allows.
- **type checker** (`src/type-checker.ts`): types and values.
- **compiler** (`src/compiler.ts`): the project's file paths and images, waits written in days or weeks, the check of
  the compiled plan, and the host's call stack.
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
| `TSP003` | Expected a speaker name | error | parser |
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
| `TSP037` | Symbol where TeaseScript writes a word | error | parser |
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
| `TSH012` | Tag with two different numbers | error | parser |
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
| `TSV011` | Invalid wait, timer, repeat count, pacing, or timeout | error | type checker |
| `TSV012` | Invalid `for` loop source | error | type checker |
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
| `TSV029` | Invalid choice | error | name pass, type checker |
| `TSV032` | Blocking command in a parameter default | error | name pass |
| `TSV033` | Invalid timer or handler return | error | name pass |
| `TSV034` | Invalid timer handle member | error | type checker |
| `TSV035` | Duration combined with a number | error | type checker |
| `TSV036` | Invalid media file, option, or cue | error | type checker |
| `TSV037` | Invalid media handle member | error | type checker |
| `TSV038` | Invalid storage key | error | type checker |
| `TSV039` | Invalid prefill | error | type checker |
| `TSV040` | List where text is shown | error | type checker |
| `TSV041` | Type mismatch | error | type checker |
| `TSV042` | Value that cannot be shown | error | type checker |
| `TSV043` | Unsupported operand, method, or property | error | type checker, plan analysis |
| `TSV044` | Mixed types | error | type checker |
| `TSV045` | Negative list index | error | type checker |
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
| `TSV057` | Invalid file target | error | name pass |
| `TSV058` | Loop with no way out | warning | plan analysis |
| `TSV059` | Invalid camera view member | error | type checker |
| `TSV061` | Wait or timer written in days or weeks | warning | compiler |
| `TSV062` | Fallback that is never used | warning | type checker |
| `TSV063` | `speaker` without a speaker | error | name pass |
| `TSV064` | Invalid regex | error | name pass |
| `TSV065` | Code that never runs | warning | plan analysis |
| `TSV066` | `exit` that never runs | warning | plan analysis |
| `TSV067` | Change of a copy that no variable holds | error | type checker |
| `TSV068` | Invalid timer display | error | type checker |
| `TSV069` | Blocking media handle, or `finish` twice | error | name pass |

## Tags (TST)

| Code | Title | Severity | Owner |
| --- | --- | --- | --- |
| `TST001` | Invalid tag query | error | parser |
| `TST002` | Tag query that matches nothing | error | type checker |
| `TST003` | Image keywords that are not tags | warning | compiler |
| `TST004` | Image tag with two different numbers | error | compiler |
| `TST005` | Invalid tag | error | type checker |
| `TST006` | Invalid `from:` of a tag query | error | type checker |

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
| `TSC010` | Unsupported instruction plan format or version | error | plan validation |

## Codes with more than one owner

A shared code is one problem found in more than one place when the owners report the same rule, which is allowed only
when they report it with the same text. It is two problems when the owners report different mistakes under one code,
which each need a code of their own.

- `TSV001` (one problem, same text)
  - parser: a declaration whose name is a keyword or another protected name, where it reads the name
  - name pass: the same rule with the same text (`protectedNameMessage`) where it finds such a declaration, and a name that is already in use
- `TSV007` (one problem, different texts)
  - name pass: a property name that a speaker declaration or an object literal gives twice
  - type checker: a key that a dict literal gives twice, also through a computed key whose text is known
- `TSV020` (one problem, different texts)
  - name pass: calls of the script's functions and of built-ins by name, such as `load` without `default:`, `askImage`, `showPopup`, `openUrl`, `exportText`, and `takePhoto`
  - type checker: method calls, `script(...)`, and the functions of the current date and time
- `TSV022` (one problem, different texts)
  - name pass: calls of the script's functions and of built-ins by name
  - type checker: method calls and `script(...)`
- `TSV029` (one problem, different texts)
  - name pass: a choice without options, which the parser already rejects with `TSP030`, so no source reaches it
  - type checker: option lists that are known to be empty, and the values, objects, number, and backgrounds of the options
- `TSV043` (one problem, different texts)
  - type checker: every operation that its operands do not support, among them a speaker property that no declaration or assignment gives a speaker the read may reach
  - plan analysis: a speaker property that a way to the read misses (V30 §37)
- `TSV055` (one problem, different texts)
  - name pass: a start value that says, asks, waits, plays media, calls a function, or uses a local or a later global
  - type checker: a start value that selects at random, with `.random` or a list in `${...}`, which needs the value's type
