# Real-script corpus inventory

This document records the current feasibility corpus and aggregate parser results. The source archives and their media
remain external inputs; this repository stores only aggregate findings and importer code.

## Corpus snapshot

| Corpus | Groovy files | Source bytes | Source lines |
| --- | ---: | ---: | ---: |
| SexScript desktop distribution | 14 | 46,638 | 1,082 |
| Domme3 | 25 | 474,372 | 14,526 |
| DisciplineClinic | 6 | 813,848 | 20,479 |
| **Total** | **45** | **1,334,858** | **36,087** |

All 45 files parse successfully through the Groovy 2.5.21 `CONVERSION` phase with the POC parser helper. Ordinary
SexScript files are parsed inside the reconstructed method-body context. `Domme3Class.groovy` is parsed as an auxiliary
Groovy compilation unit.

The other user-provided DisciplinePack ZIPs contain images/sounds rather than Groovy and are therefore package-resource
inputs, not parser-corpus inputs.

## AST shape encountered

The most common normalized AST node kinds are:

| Node kind | Count |
| --- | ---: |
| constant | 50,858 |
| variable | 33,501 |
| expression statement | 21,241 |
| method call | 18,417 |
| binary expression | 14,606 |
| block | 4,077 |
| if | 2,077 |
| declaration | 1,962 |
| break | 1,422 |
| case | 1,408 |
| list | 1,052 |
| property access | 473 |
| closure | 322 |
| return | 275 |
| switch | 270 |
| postfix expression | 247 |
| while | 101 |
| cast | 76 |
| for | 76 |
| range | 63 |
| map entry | 53 |
| constructor call | 41 |
| map | 11 |
| try/catch | 2 |
| continue | 1 |

Two Groovy expression classes are not normalized yet and are emitted explicitly as unsupported nodes:

- `org.codehaus.groovy.ast.expr.EmptyExpression`: 26 occurrences;
- `org.codehaus.groovy.ast.expr.ArrayExpression`: 4 occurrences.

This is intentionally visible in the JSON AST. The parser helper does not drop unknown constructs silently.

## SexScript API usage

The corpus contains 14,233 calls to 35 distinct API-9/source-level SexScript methods when counting inherited calls and
`main.<method>` calls from the auxiliary Domme3 helper class.

| API method | Calls |
| --- | ---: |
| `show` | 4,820 |
| `wait` | 3,622 |
| `showButton` | 1,734 |
| `getRandom` | 1,081 |
| `save` | 939 |
| `setImage` | 435 |
| `getBoolean` | 319 |
| `loadInteger` | 286 |
| `loadBoolean` | 258 |
| `loadString` | 135 |
| `showPopup` | 112 |
| `playSound` | 73 |
| `getSelectedValue` | 70 |
| `getTime` | 65 |
| `load` | 65 |
| `waitWithGauge` | 60 |
| `getInteger` | 38 |
| `getString` | 26 |
| `setInfos` | 22 |
| `useUrl` | 18 |
| `playBackgroundSound` | 15 |
| `getBooleans` | 9 |
| `loadFloat` | 8 |
| `loadFirstTrue` | 6 |
| `exit` | 4 |

The remaining observed API calls occur three times or fewer each. The old online `send`/`receive` surface and OS helper
calls are present, but rare in this corpus.

## Plain-Groovy patterns that matter

The scripts also contain behavior that is not part of the SexScript API:

- `sleep(...)`: 94 calls. This is a promising recognized migration pattern because it often expresses a blocking delay
  in milliseconds, but it is plain Groovy behavior and must be validated before rewriting to TeaseScript `wait`.
- `GroovyClassLoader`: 23 constructor calls, with corresponding `addClasspath`/`loadClass` use. Domme3 uses this to load
  `Domme3Class.groovy` from its package.
- `Class.forName`: 19 calls and reflection helpers such as `getMethod`, `invoke`, `getConstructor`, and `newInstance`.
- `File`: 6 constructor calls.
- `Date`: 10 constructor calls.
- `ByteArrayOutputStream`: 2 constructor calls.

`Domme3Class.groovy` contains 21 methods. Some are pure calculations, but others call SexScript interactions, media,
storage, or delays through a `main` parameter. Therefore an auxiliary Groovy class is not automatically a `.ts` helper
candidate. Resumable methods may need to become TeaseScript functions or be inlined/rewritten; synchronous `.ts` is
appropriate only for portable non-suspending logic.

## Implications for the first lowering slice

The corpus supports prioritizing these conversions:

1. literals, variables, assignments, arithmetic/comparison/boolean expressions;
2. `if`/`else`, `switch`/`case`, `while`, range iteration, `break`, and `continue`;
3. the high-frequency SexScript API calls above;
4. simple helper closures and `.each` range/list iteration;
5. recognized `sleep(milliseconds)` to TeaseScript elapsed-time waits where the argument can be proven numeric;
6. auxiliary-class methods only after class-loading use has been resolved to a known package-local source.

Reflection, arbitrary JVM/filesystem/platform access, dynamic class loading that cannot be resolved to package-local
source, and alias/type behavior that changes TeaseScript semantics remain diagnostic/manual-migration cases.
