# Message markup

**Status:** Accepted
**Issue:** #397

This specification defines the constrained presentation markup for authored Standard-chat `say` output. It owns the
markup grammar, escaping, recovery, visible-text derivation, and the shared parser and `escapeMarkup()` contracts.
TeaseScript string syntax and interpolation remain defined by the accepted language specification. The initial surface
here may be extended by a later accepted specification update when a concrete use case requires it.

## Scope and processing order

A `say` value remains an ordinary TeaseScript string. The engine evaluates the expression and all interpolation exactly
once, performs any visible-text value conversion already required by `say`, and then parses the complete resulting
string as message markup. An interpolated formatted fragment therefore participates in the same parse as surrounding
text. An author uses `escapeMarkup()` when interpolated text must remain literal.

The markup layer applies only to authored Standard-chat `say` output. Player-authored transcript entries remain plain
text. Markup is presentation syntax rather than TeaseScript program syntax, so malformed markup in a dynamically
produced string does not cause a compilation or runtime failure.

The first surface contains only the forms defined below. It does not include raw HTML, arbitrary CSS, author classes or
selectors, images, tables, fenced code blocks, scriptable content, event handlers, iframes, or general BBCode aliases.
Angle-bracket text has no special meaning and remains literal.

## Lines and block forms

The parser treats LF and CRLF as line endings and preserves the original line-ending text. A block marker is recognized
only at the first character of a line. Leading spaces or tabs make a would-be marker ordinary text. Every input line
ending remains one line ending in flattened visible text; markup does not fold or insert whitespace.

The line grammar is:

```ebnf
document       = line, { line-ending, line } ;
line           = heading | quote-line | unordered-item | ordered-item | plain-line ;
heading        = ( "#" | "##" | "###" ), " ", inline-sequence ;
quote-line     = ">", " ", inline-sequence ;
unordered-item = "-", " ", inline-sequence ;
ordered-item   = nonzero-digit, { digit }, ".", " ", inline-sequence ;
plain-line     = inline-sequence ;
line-ending    = LF | CRLF ;
digit          = "0" | nonzero-digit ;
nonzero-digit  = "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" ;
```

The marker must be unescaped and exact. `#### Heading`, `#Heading`, `0. item`, `-item`, and indented markers are plain
text. The content after a recognized marker may be empty and is parsed using the inline grammar.

Adjacent quote lines form one quote block. Adjacent unordered items form one unordered list, and adjacent ordered items
form one ordered list; each ordered item retains its authored positive decimal ordinal. A blank line, a different block
kind, or a plain line ends the group. Blocks do not nest in this surface: a block-looking prefix in the content of a
quote or list item is inline literal text. Presentation may style or announce these structures, but it does not replace
the authored line endings or ordinals in the semantic representation.

Headings have levels 1 through 3. Their visual sizes are controlled transcript presentation rather than browser-default
heading sizes.

## Inline forms

The following inline constructs are recognized within one logical line:

| Form | Meaning |
| --- | --- |
| `*text*` | italic |
| `**text**` | bold |
| `~~text~~` | strikethrough |
| `` `text` `` | inline code |
| `[label](https://example.com)` | labeled link |
| `https://example.com` | bare link |
| `[u]text[/u]` | underline |
| `[color=#ff3344]text[/color]` | foreground color |
| `[bg=#ffee88]text[/bg]` | background highlight |
| `[weight=light]text[/weight]` | font weight |
| `[size=large]text[/size]` | relative text size |
| `[spoiler]text[/spoiler]` | concealed text that the reader can reveal |

The valid recursive shapes are:

```ebnf
inline-sequence = { inline-node } ;
inline-node     = escaped-character | inline-code | labeled-link | extension
                | bold | italic | strikethrough | bare-link | literal-text ;
bold            = "**", inline-sequence, "**" ;
italic          = "*", inline-sequence, "*" ;
strikethrough   = "~~", inline-sequence, "~~" ;
inline-code     = "`", code-content, "`" ;
labeled-link    = "[", link-label, "](", link-target, ")" ;
```

The recognition, boundary, nesting, and recovery rules below constrain this shape and resolve its otherwise ambiguous
alternatives. `extension`, `bare-link`, escaping, and their value alphabets are defined in their dedicated sections.

Inline constructs never span a line ending. A Markdown-like delimiter span must have a matching unescaped closer on
the same line and must contain at least one non-whitespace character. The character immediately inside each delimiter
cannot be whitespace. A delimiter that cannot form such a span remains literal.

Inline code is resolved before other inline constructs. Its content is literal except for the backslash escapes defined
below: formatting delimiters, tags, and URLs inside it are not interpreted. The first eligible unescaped backtick closes
the candidate. A complete candidate whose content is empty, starts or ends with whitespace, or contains only whitespace
is one literal atom. An unmatched opening backtick is literal and scanning then continues after it.

Outside inline code, balanced constructs may nest. Delimiters close in last-opened, first-closed order; crossing spans
are not formatting. At a run of asterisks, active asterisk spans close from the inside out before remaining characters
open a bold pair and then an italic single. This makes `***text***` a bold span containing an italic span and gives the
same result on every parser. Runs of three or more tildes remain literal; strikethrough uses exact `~~` delimiters.

Labeled-link labels are parsed for inline formatting with link recognition disabled, so links cannot nest. Bracket
extension content uses the normal inline grammar. A construct's delimiters are syntax rather than text; all text leaf
content, including Unicode content, is preserved exactly.

## Bracket extensions and values

Bracket tag names and named values are ASCII lowercase and case-sensitive. No whitespace is allowed inside a tag. The
complete set of valid opening and closing spellings is:

```text
[u] [/u]
[color=#RRGGBB] [/color]
[bg=#RRGGBB] [/bg]
[weight=thin|light|normal|medium|semibold|bold|black] [/weight]
[size=small|normal|large|x-large] [/size]
[spoiler] [/spoiler]
```

`RRGGBB` means exactly six ASCII hexadecimal digits; digit letters may be uppercase or lowercase. The representation
normalizes a valid color to lowercase. These values are constrained data. A parser never accepts a CSS declaration,
function, property name, class, selector, or additional attribute through these tags. Player themes own the exact visual
mapping of the accepted weight and size names.

A recognized valid opening tag formats content only when a matching closer can complete a properly nested span on the
same line. An empty extension span is valid. An unknown tag, invalid value, extra attribute, mismatched closing tag, or
unmatched tag remains literal text. A literal malformed tag does not suppress otherwise valid inline markup around or
inside it. In crossed input, a closing tag that does not match the currently open extension is literal; later matching
closers may still complete their spans.

Examples:

| Input | Result |
| --- | --- |
| `[color=red]x[/color]` | the complete text remains literal |
| `[b]x[/b]` | the complete text remains literal |
| `[u]x` | `[u]` is literal and `x` is ordinary text |
| `[u][spoiler]x[/u][/spoiler]` | `[u]` and `[/u]` are literal; the spoiler span is valid |

## Links

A link target is an absolute URL whose scheme is `http` or `https`, compared case-insensitively, and whose parsed URL
has a non-empty host. Before URL parsing, the candidate must contain no whitespace, C0 control character, DEL,
backslash, or escaped character. The shared implementation uses the platform URL parser and retains its canonical URL
serialization as the activation target. Any other scheme or invalid URL remains non-link literal text.

A labeled link has the exact form `[label](target)`. The label must contain at least one non-whitespace visible
character. Its closing `](` is the first eligible unescaped pair outside an inline-code candidate or a complete valid
bracket-tag token, allowing those supported forms inside the label. The target cannot contain whitespace, `(`, or `)`.
If text has the complete link-shaped delimiters but its label or target is invalid, that complete candidate is one
literal atom: its target is not reconsidered as a bare link.

A bare URL candidate begins with `http://` or `https://` at the start of inline content or after a character that is not
a Unicode letter, mark, number, or underscore. It continues until whitespace, a control character, or one of
`` < > \" ' ` * ~ [ ] `` occurs. Terminal `. , ; : ! ?` are excluded from the target. A terminal `)` or `}` is
excluded while it has no unmatched opener of the same kind inside the candidate. Excluded terminal punctuation remains
ordinary text after the link.

The displayed content of a labeled link is its parsed label. The displayed content of a bare link is the exact consumed
URL substring. The Player exposes a discoverable destination through ordinary link accessibility behavior, uses only
the validated activation target, and opens an external destination without replacing the active Player session. Exact
production host and sandbox navigation policy is outside this grammar.

## Backslash escaping

An unescaped backslash protects one following syntax-significant character. The backslash is removed and the protected
character becomes literal data that cannot participate in a block marker, delimiter, tag, labeled link, or bare URL.
The syntax-significant set is:

```text
\  *  ~  `  [  ]  (  )  #  >  -  .  :
```

For example, `\*literal\*`, `\[u]literal\[/u]`, `\# heading`, `1\. item`, and `https\://example.com` flatten to the
same visible characters without creating their respective structures. `\\` produces one protected literal backslash.
A backslash before any other character, or at the end of a line, remains an ordinary visible backslash. An escape never
continues across a line ending.

Escape processing applies before block recognition and while parsing every inline context, including inline code and
link labels. A protected character retains that status for the complete parse; removing the backslash must not expose a
second-pass construct.

## Malformed input and recovery

Parsing is deterministic and total for every string. It does not reject a message because markup punctuation is
malformed. The parser scans left to right using these priorities where more than one construct could begin:

1. backslash escape;
2. inline code;
3. labeled link;
4. valid bracket extension;
5. bold, italic, or strikethrough delimiter;
6. bare URL;
7. literal text.

Only a complete valid construct consumes its syntax. When a candidate cannot complete, its first character is emitted
literally and scanning continues, allowing later independent constructs to be recognized. The invalid complete
labeled-link candidate and complete invalid inline-code candidate defined above are the atomic recovery cases. Unknown
and malformed tag or link text otherwise survives exactly, apart from any explicit valid escapes it contains. Static
editor tooling may diagnose likely author mistakes, but the runtime result remains displayable literal text.

## Structured content and visible text

The shared parser produces one immutable, JSON-safe, discriminated message representation. Blocks contain lines of
visible text and a flat ordered table of typed spans over that text. Span offsets are zero-based half-open UTF-16 code
unit ranges, matching JavaScript string and DOM range indexing. Each span also records its zero-based nesting depth. An
outer span precedes its nested spans; spans are properly nested or disjoint and never cross. Empty extension spans have
equal start and end offsets, with depth preserving the distinction between nested and adjacent empty spans. This flat
form preserves arbitrary accepted nesting without making JSON serialization recurse through an input-deep object tree.

The representation distinguishes line endings, headings, quote blocks, ordered and unordered lists, inline code, the
three Markdown-like text styles, the six bracket extensions, and validated links. Link spans contain only the validated
activation target. Style spans contain only the constrained values above. Line text is plain text rather than authored
HTML. Exact TypeScript property names and serialized format versions belong to the implementation.

The following semantic invariants are required:

- the runtime, pacing logic, transcript adapter, and Player consume the same parsed representation or helpers from its
  owning module;
- no consumer reparses authored markup with a separate grammar;
- the Player constructs framework/DOM text and supported elements directly and never sends authored text through
  `innerHTML` or an equivalent raw-HTML path;
- parsing uses no host capability, pending action, RNG, or mutable session state;
- prepared `say` content captures structured content and visible text together, and checkpoint/restore validation keeps
  them equivalent without reevaluating the source expression;
- uninterrupted and restored execution produce equivalent structure, visible text, pacing, and event order.

Flattened visible text is obtained by concatenating textual leaf content and original line endings in document order:

- recognized block markers, inline delimiters, extension tags, and escape backslashes contribute no characters;
- inline-code and style-span content contributes its text;
- spoiler content contributes its concealed text;
- a labeled link contributes only its visible label, while a bare link contributes its displayed URL;
- list ordinals and bullet markers are structural and contribute no characters;
- literal unknown, malformed, unmatched, excluded, or raw-HTML-like text contributes all of its characters.

Smart pacing counts this flattened visible text using the accepted pacing rules. For example, `**Warning**` flattens to
`Warning`, `[label](https://example.com)` flattens to `label`, and `<b>text</b>` remains the literal visible text
`<b>text</b>`.

## Shared helper contracts

The owning message-markup module provides one parser operation and one visible-text operation over its result. Both are
pure, deterministic, synchronous, and side-effect free. Parsing a string returns structured content plus its flattened
visible text and does not throw for malformed markup. The visible-text operation must not accept or interpret a second
markup grammar.

`escapeMarkup(text)` is a public Platform Standard Library function with this contract:

- it accepts one string and returns one string synchronously;
- it walks the input once and prefixes `\` to every backslash and every character in the syntax-significant set above;
- it preserves line endings and every input visible character;
- parsing its return value produces only literal text and line endings, never formatting, a block, or a link;
- flattening that parsed value equals the original input exactly;
- it is deterministic and uses no host capability, pending action, RNG, state, or checkpoint-specific data;
- it is not idempotent: escaping an already escaped string escapes the escape backslashes again.

The public TeaseScript spelling is the ordinary call `escapeMarkup(text)`. The current POC may use the smallest
compiler/runtime prelude bridge needed to call it, but escaping remains isolated shared pure functionality owned by the
Platform Standard Library. This contract does not add special grammar, a permanent engine primitive, or general future
library linkage, package, manifest, version, or replacement infrastructure.
