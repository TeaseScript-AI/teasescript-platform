# Diagnostics

Every code that a compiler diagnostic, runtime failure, developer warning, or checkpoint error carries is registered
once in `src/diagnostic-codes.ts`: the pass or component that reports it (its owner), its severity, a short title, and
the section that explains it. A rule that is an error where the compiler proves the problem and a warning where the
script checks it when it runs keeps one code with both severities, shown as `error or warning`. The new checker's stop
(`TSV076`) warns once and marks each function or file top level it did not check completely with an information
(`info`), which the editor shows at its information level and which never stops a compile. Code that reports a
diagnostic takes the registry's code types, so an unregistered code does not compile. `tests/semantic/diagnostic-codes.test.ts`
checks that every code in `src/` is registered and reported only by its owners, and that every registered code is still
reported or marked as retired. A retired code stays registered, so that it is never given to another problem.

This document lists the compiler's codes. The other runtime errors (`TSR`) are listed in
[Runtime errors](RUNTIME.md#runtime-errors), checkpoint errors (`TSK`) in
[Checkpoint boundary](RUNTIME.md#checkpoint-boundary), and each developer warning (`TSW`) in the section of its
feature.

One problem gets one code, whichever pass finds it
([One home for each language rule](review-and-audit/IMPLEMENTATION-AND-REVIEW.md#one-home-for-each-language-rule)).
The codes that more than one owner reports are listed in
[Codes with more than one owner](#codes-with-more-than-one-owner), which also states when a runtime failure uses a
compiler code and its text.

## Messages

A compiler diagnostic or runtime failure says what went wrong and why, naming the real operand or value, and what to do
about it, as code only when that code compiles where the message says to put it and otherwise in words (owner decision,
2026-10-28), in whole sentences without semicolons, and quotes source in single quotes, as in `'total / count'` (owner
decision, 2026-10-09). It names its subject, such as the file, value, or place, instead of "it" or "this" (owner
decision, 2026-10-27). A sentence that authors read uses no implementation terms, such as "compiler", "follow", or
"store", unless they help the author fix the problem, and says "type", never "kind" (owner decision, 2026-10-27). Where
a whole number is required, a value of type `number` is "a number that can have decimals", and the message names the
line that brings them; elsewhere "a number" stays the general word (owner decision, 2026-10-27). A warning of a check
the run makes states the rule, then what the value may be and what follows, as in `contains() needs text (string) or a
regex for 'part', but 'v' may be a whole number (integer) here. If it is, the Tease stops with an error at this line.`
(`may hold` and `If it does` for what a value holds), then its fix. A warning about failing a required test says `If it
does not, the Tease stops` (2026-10-28, #1213). For arguments, keys, iterables, and button values, a generic
unknown-type warning is omitted when the same check already warns about a rejected known type (owner review of #1437,
2026-10-29).

An operator's expansion of one unknown operand counts as one offending type, with one diagnostic and one check (the
lead, 2026-10-23). A member access likewise gets one warning per access and check: when the property's own answer
explains its unknown type, an unknown receiver adds no second warning there. The receiver's own absence still warns at
its own access, and the retained warning states the cause (2026-10-30, #1481).

The branch cause says `depends on which branch runs` (2026-10-28, #1213). A type test that holds removes possible types
without losing the read's cause. Where no definition supplies the narrowed read, use the untested read's cause only if it is unique; if the untested read has several causes, keep the narrowed value's own causes (2026-11-08, #2074).

A suggested fix never contains a placeholder such as `default: ...`, and what cannot be written in full is said in words
(owner decision, 2026-10-28, #1268).

Classify literals and variable or property paths from syntax. A fix uses its subject directly in a code example only for
a stable path. For a random selection, call, or computed index, advise keeping the value in a new variable, otherwise
use words alone. Removing an unsafe example keeps the advice. A join example uses only the non-text operand's own text,
and a suggested first showable property is a plain value. A method call is not described as an assignment, a speaker's
method call gets the no-methods advice without a property cause, and a literal condition gets `Compare it instead.`
(2026-10-28, #1213).

Every code suggestion, including a type inside prose, uses the same validity rule: prove operand or receiver types,
accepted result types, grouping, reads, and presence at the suggested position, accounting for severity and any divisor
it reaches. An unproved fact gives words. Presence proofs cover a closed set of expression forms and every operand they
evaluate, proved non-null at every depth (2026-10-28, #1296).

The proof covers a fallback the fix introduces and an absence the diagnostic reports; a diagnosed missing key or
property gives words. A fallback the fix writes is words where the value divides at the diagnostic's site, including
through a calculation or member receiver. A function argument's requirement is proved even for an unannotated parameter.
Values the script already computes and the fix only names correctly keep the script's runtime behavior, as does a stored
value divided on a later line (2026-10-28, #1296).

After an error, or when a form adds a read at a new site or evaluates a receiver again, presence is proved or the advice
is words. A warning's form that only wraps the diagnosed read at the same site may keep that read's runtime behavior
(2026-10-28, #1296).

A declaration form keeps the declaration's own initializer, including a call or index read, and a guard form gives the
complete guarded statement. A type suggestion names the type at the type position, without carrying the author's
initializer into a replacement declaration.

An unchecked-region mark covers its whole region, the stop warning itself covers none, and the diagnostic's own site is
judged without its own mark. No type-test form is offered where the read itself stops (2026-10-28–29, #1296, #1273).

A kept value uses `value`, else the first free `value2`, `value3`, and so on. Avoid identifier spellings across every
project file, before or after the use, including functions, parameters, paired names, identifiers within text or
property expressions, host globals, and built-ins; property names alone do not reserve the name (2026-11-04, #1715).

When an assignment types an object's property but checks the value the object comes from, TSV041's advice names the
property and where the narrowest expression owning it gets its value, in words. Advise giving the property its type in a
`load` default only when that type excludes null and the origin is proved: the load is bound once, the property path is
plain with no other definition at any prefix, and the receiver's category is proved (2026-10-30, #1488). For a property
below a partly external value, this advice precedes the generic whole-value test, except that a declared place without a
type test keeps its existing advice. Find the owning expression through object literals, selected list elements, and
either `otherwise` operand. Where the value's destination is unknown or outside the checked place's path, keep the
value's own check (2026-11-05, #1730).

For a checked element below the stored value through collections, advise testing the value's whole receiving type,
following the root's written annotation to the stored value and retaining every optional layer. An unproved layer,
including a written copy or property path, gives words and keeps its own check. Do not offer a null fallback for the
whole value, and use the property advice for a property step (2026-11-05, #1764).

A member read marks the whole access, including its receiver. An operator marks its offending operand, or the operation
once if there is no offending operand. An obligation uses its diagnostic's site (the lead, 2026-10-26).

An external-data boundary sits at the ingress expression, including inside a literal, with the destination's target and
contract. A record literal's one record-level boundary uses the first evaluated ingress cell. A definite non-fitting
contribution inside nested literals marks the innermost offending expression recursively (the lead, 2026-10-24). A stop
preserves the unstopped site's choice (2026-10-28, #1063).

For named external data in a nested literal cell, a selection, `otherwise`, `get`, or copy method has no offending
operand: the destination's check marks the operation once, at the assigned value's span. Concatenation or removal marks
the named read that brought the type. Inline host data in an `otherwise` fallback or `get` default likewise uses the
assigned value's span, while typed `load` or `fromJson` defaults keep the call's site. When host-member and own-read or named data combine, the destination's check uses the assigned value's span for the merged place, while the member's own root-place check stays at the member read (the lead, 2026-10-26).

For `askChoice` with an inline external option, the boundary and a written destination's warning and copy check sit at
that option's expression. With no destination assignment, the boundary sits at the consumer's operand against `unknown`.
For options held in a variable, the boundary stays at that variable's assignment, targeting its element, and the
destination's warning and check stay at the answer. The choice result adds no ingress of its own, and literal-only
options add no boundary (the lead, 2026-10-24).

An obligation left undecided after a stop keeps its diagnostic code as a `not checked (budget)` mark at its owning site,
never silently dropped. When retained state decides the original diagnostic's shape, publish it with its original code
and site; only an undecided shape permits a mark at the assignment that owes the check (2026-10-27, #1063).

If an assignment's check opens below an undecided path, its TSV041 mark names that path (2026-10-28, #1063). Before
admission settles, mark every assignment into an inferred place and every external-data assignment without a written
destination, while keeping checks and boundaries against written types. At such stops, an assignment's mark stands for
diagnostics within its value span or an error brought by that assignment, including one reported at a later read. A mark
covers only effects that depend on it, including a stand-in boundary formed for it (2026-10-28, #1063, #1165).

At a stop before admission settles, checks against written types keep their grouping, sites, and collection labels from
the written type and literal syntax (2026-10-28, #1063). A written assignment with an undecided literal part keeps its
mark at the literal. An unknown type caused by budget exhaustion uses the assigned value's span even beside external
unknown data, keeping its explanation, target, receiving type, and boundary check, with one obligation per place
(2026-11-02, #1630).

These diagnostic ownership rules remain subject to the candidate route's publication and decline rules in [Resource
limits](RESOURCE-LIMITS.md#coarse-type-core-bounds).

A mixed-list error describes each element with its own type, retaining the earliest element's nullability below the
element and the `?` of every intermediate collection layer on each side. At a value's own level, describe nullability at
its occurrence, including narrowing. For `otherwise`, use the narrowed operand and include the fallback's null only
where the operand may be null. Below that level, a written copy follows its source expression, another read or call
result follows its place's accepted type, and other forms follow the values they hold. A join follows only its accepted
operands (2026-10-28–11-06, #1213, #1764, #1789).

The later element keeps its own types and adds null only where its leaf may hold it under the same rule. A narrowed
copy's own level holds no null, while a typed host value may unless guarded (2026-11-06, #1819). A join describes each
operand's leaf null from the types established for that occurrence, while compatibility uses the receiving type. A
join-held binding retains its written nullability (2026-11-07, #1899).

Each side names its own nested collections as lists, dicts, or sets. For dict descriptions, follow an `otherwise`
operand only where it may hold a value at every depth, and its fallback where the operand may be null. Treat `get`,
`load`, and parse defaults as their own values, and describe dict layers below a value's own level from the values its
contract admits. These descriptions do not change which values are accepted or which runtime checks run (2026-11-06–08,
#1814, #2017).

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
| `TSV076` | Script too large to check completely before it plays | warning or info | type checker |

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

A shared code is one problem that each owner finds in another place and reports with the same text. Where an entry below
gives the runtime the same text, that is the compile-time error's message text, except for details that depend on the
source as written or on static types, which the runtime does not have, such as the unit the compiler suggests for a
number. Every other runtime check uses a `TSR` code of [Runtime errors](RUNTIME.md#runtime-errors), also where the
compiler checks the same rule, such as `TSR058` for a value that does not fit its receiving place and `TSR024` for a
list index that is not a whole number. Two problems need a code each.

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
  - plan analysis: the same rule with the same text for a computed `goto`, such as `goto (next)`, when the references it may hold can name only one file and it holds declarations only, and with a text of its own when they can name several and all hold declarations only
- `TST004`
  - parser: a tag that a file header gives two different numbers (`conflictingTagMessage`)
  - compiler: the same rule with the same text, naming the image, for the keywords of an image
  - type checker: the same rule with the same text for the written tags of `takePhoto(tags: [...])`
- `TSC011`
  - name pass: a path or glob written out that names a file the host could not load, or may name a file in a folder it could not read, as the target of a `goto` or `call`, in `script(...)`, as the `from:` of a tag query, or as the file of `showImage`, `playAudio`, or `playVideo`, with the host's reason as its text
  - compiler: the same rule with the same text for `main.tease`, where every session starts, and as a warning at each other file or folder the host could not load that no such path or glob names but code may use: a computed `goto` or `call` that can run, when a script reference may name the file, or, for a folder, any media or image file known only when the script runs, also in code that never runs. Such a `.tease` file or folder that no such code may use is `TSV065`, with the host's reason after the `TSV065` text. When errors prevent reachability analysis, each keeps `TSC011`
