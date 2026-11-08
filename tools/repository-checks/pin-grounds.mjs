import { ts } from "ts-morph";

// The ground check of the pins `pin-suites.mjs` lists (`pin-suites.mjs --check-grounds` runs it): a pinned value that
// is new or moved needs a changed comment where its ground is written, "N units more or fewer since #…".
//
// It reads each changed file holding a suite's pins, at the merge-base and at the head, with the TypeScript parser that
// `ts-morph` exports (`import { ts } from "ts-morph"`, a development dependency already): no type checker, no
// evaluation. `GROUNDS` declares, for each suite, where its expected values sit: the test or declaration that owns
// them (by its title or name), the expressions inside it that hold them, and the header whose comment grounds them all.
// A reader takes only literal values in its declared shapes: a numeric literal, or a counter snapshot string
// (`"checks 142 …"`), in the declared arrays and objects. Any other expression there (a call, a name, arithmetic, a
// template, a concatenation, a spread) is refused, naming the value and the fix; so is a file that does not parse, an
// owner missing or found twice, and a shape the reader does not know. Nothing passes by its layout: line breaks,
// comments and formatting do not change what is read.
//
// Each record (a row of values, f18's object, one counter snapshot) is compared by its owner, its place and its values.
// A head record whose values a base record of the same owner and place held is unchanged, each base record matching one
// head record; any other head record is new or re-pinned and needs a touched comment: a comment on lines of its own,
// with an added line of the change among them, either leading the record or a container of it up to the statement of
// its owner that holds it, or leading its owner's header (a test, and the test's first statement; or the declared
// anchor of a pin outside a test). It judges that the ground was touched, not whether it is true: the reviewer does. A
// suite whose pins are listed sites (`listed`) is not read: each site's reason names it, as its own test requires.

const COUNTERS = /^[A-Za-z]+ \d+(?: [A-Za-z]+ \d+)*$/u;
const FIX_SHAPE =
  "Write the value as a literal in its declared shape, or declare the shape in tools/repository-checks/pin-grounds.mjs.";
const FIX_OWNER =
  "Restore it, or update its declaration in tools/repository-checks/pin-grounds.mjs.";

/** A file parsed as TypeScript, with its parse errors' count. */
export function parse(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return { source, errors: source.parseDiagnostics.length };
}

/** The 1-based line of a position. */
const lineOf = (source, position) => source.getLineAndCharacterOfPosition(position).line + 1;

/** The top-level `test(…)` statements whose title starts with `title`. */
const testsTitled = (source, title) =>
  source.statements.filter((statement) => {
    const call = ts.isExpressionStatement(statement) ? statement.expression : undefined;
    return (
      call !== undefined &&
      ts.isCallExpression(call) &&
      ts.isIdentifier(call.expression) &&
      call.expression.text === "test" &&
      call.arguments.length > 0 &&
      ts.isStringLiteralLike(call.arguments[0]) &&
      call.arguments[0].text.startsWith(title)
    );
  });

/** The top-level variable statements declaring `name`. */
const declaring = (source, name) =>
  source.statements.filter(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name,
      ),
  );

/** The nodes below `node`, itself included, that `accept` takes, in source order. */
function within(node, accept) {
  const found = [];
  const visit = (child) => {
    if (accept(child)) found.push(child);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/** An `assert.<method>(…)` call whose first argument `actual` accepts. */
const isAssert = (node, method, actual) =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  node.expression.getText() === `assert.${method}` &&
  node.arguments.length >= 2 &&
  actual(node.arguments[0]);

/** A property assignment of an object literal by its name, or `undefined`. */
const propertyOf = (object, name) =>
  object.properties.find(
    (property) => ts.isPropertyAssignment(property) && property.name.getText() === name,
  );

/** What a node is, for a refusal. */
function kindOf(node) {
  if (ts.isCallExpression(node)) return `a call (${node.expression.getText()})`;
  if (ts.isIdentifier(node)) return `a name (${node.text})`;
  if (ts.isPropertyAccessExpression(node)) return `a name (${node.getText()})`;
  if (ts.isBinaryExpression(node)) return "arithmetic or a concatenation";
  if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return "a template";
  if (ts.isStringLiteral(node)) return "a string";
  if (ts.isPrefixUnaryExpression(node)) return "a signed or negated value";
  if (ts.isSpreadElement(node)) return "a spread";
  if (ts.isOmittedExpression(node)) return "an omitted element";
  return `a ${ts.SyntaxKind[node.kind]}`;
}

/**
 * One file's reading: its records, each `{ owner, place, values, node }`, and its refusals, each `{ line, what, fix }`.
 * A reader names the owner it reads in (`within`), adds records, and refuses what it cannot read.
 */
class Reading {
  constructor(source) {
    this.source = source;
    this.records = [];
    this.refusals = [];
    this.owners = [];
    this.owner = undefined;
  }
  refuse(node, what, fix = FIX_SHAPE) {
    this.refusals.push({ line: lineOf(this.source, node.getStart()), what, fix });
  }
  /** Exactly one of `nodes`; else a refusal that `what` is not found once. */
  one(nodes, what) {
    if (nodes.length === 1) return nodes[0];
    this.refusals.push({
      line: nodes.length > 1 ? lineOf(this.source, nodes[1].getStart()) : 1,
      what: `${what} is ${nodes.length === 0 ? "not found" : `found ${nodes.length} times`}`,
      fix: FIX_OWNER,
    });
    return undefined;
  }
  /** Reads in `owner` (`{ name, header, scope }`): its records are its, grounded by its header. */
  in(owner, read) {
    this.owners.push(owner);
    this.owner = owner;
    read();
    this.owner = undefined;
  }
  record(place, values, node) {
    this.records.push({ owner: this.owner, place, values, node });
  }
  /** A numeric literal's value, separators aside; else a refusal and `undefined`. */
  number(node, place) {
    if (ts.isNumericLiteral(node)) return node.getText().replaceAll("_", "");
    this.refuse(node, `${place} is ${kindOf(node)}, not a numeric literal`);
    return undefined;
  }
  /** An array literal's elements, each read by `each`; else a refusal. */
  array(node, place, each) {
    if (!ts.isArrayLiteralExpression(node)) {
      this.refuse(node, `${place} is ${kindOf(node)}, not an array literal`);
      return;
    }
    for (const element of node.elements)
      if (ts.isSpreadElement(element) || ts.isOmittedExpression(element))
        this.refuse(element, `${place} holds ${kindOf(element)}`);
      else each(element);
  }
  /** Numeric literals: their values, `undefined` once one is not. */
  numbers(node, place) {
    const values = [];
    let read = ts.isArrayLiteralExpression(node);
    this.array(node, place, (element) => {
      const value = this.number(element, place);
      if (value === undefined) read = false;
      values.push(value);
    });
    return read ? values : undefined;
  }
  /** A row of numeric literals as one record. */
  row(node, place) {
    const values = this.numbers(node, place);
    if (values !== undefined) this.record(place, values, node);
  }
  /** Rows `depth` arrays deep, each innermost row a record. */
  rows(node, place, depth) {
    if (depth === 0) this.row(node, place);
    else this.array(node, place, (element) => this.rows(element, place, depth - 1));
  }
  /** A counter snapshot string as one record. */
  counters(node, place) {
    if (ts.isStringLiteral(node) && COUNTERS.test(node.text))
      this.record(place, node.text.split(" "), node);
    else this.refuse(node, `${place} is ${kindOf(node)}, not one counter snapshot string`);
  }
  /** An object literal with exactly the properties `read` names, each read by its function. */
  object(node, place, read) {
    if (!ts.isObjectLiteralExpression(node)) {
      this.refuse(node, `${place} is ${kindOf(node)}, not an object literal`);
      return false;
    }
    let known = true;
    for (const property of node.properties)
      if (!ts.isPropertyAssignment(property) || !(property.name.getText() in read)) {
        this.refuse(
          property,
          `${place} holds ${kindOf(property)}, not one of ${Object.keys(read).join(", ")}`,
        );
        known = false;
      }
    for (const [name, each] of Object.entries(read)) {
      const property = propertyOf(node, name);
      if (property === undefined) {
        this.refuse(node, `${place} has no ${name}`);
        known = false;
      } else each(property.initializer, `${place}.${name}`);
    }
    return known;
  }
  /** The array literal `name` declares inside `scope`, read element by element. */
  declaredArray(scope, name, what, each) {
    const declaration = this.one(
      within(scope, (node) => ts.isVariableDeclaration(node) && node.name.getText() === name),
      what,
    );
    if (declaration?.initializer === undefined) return;
    this.array(declaration.initializer, name, each);
  }
}

/** The block body of a test's callback, or `undefined`. */
function bodyOf(test) {
  const callback = test.expression.arguments.at(-1);
  return callback !== undefined &&
    (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
    ts.isBlock(callback.body)
    ? callback.body
    : undefined;
}

/** A reader in the test whose title starts with `title`: `read(reading, body)` in it, grounded by its header. */
const inTest = (title, read) => (reading) => {
  const test = reading.one(testsTitled(reading.source, title), `the test "${title}…"`);
  if (test === undefined) return;
  const body = bodyOf(test);
  if (body === undefined) {
    reading.refuse(test, `the test "${title}…" has no block body`, FIX_OWNER);
    return;
  }
  reading.in({ name: title, header: [test, body.statements[0]].filter(Boolean), scope: body }, () =>
    read(reading, body),
  );
};

/** A reader of the top-level declaration `name`, grounded at the node `anchor` finds. */
const inDeclaration = (name, anchor, read) => (reading) => {
  const statement = reading.one(declaring(reading.source, name), `the declaration of ${name}`);
  const declaration = statement?.declarationList.declarations.find(
    (each) => each.name.getText() === name,
  );
  if (declaration === undefined) return;
  if (declaration.initializer === undefined) {
    reading.refuse(statement, `${name} has no initializer`, FIX_OWNER);
    return;
  }
  const header = anchor(reading);
  if (header === undefined) return;
  reading.in({ name, header: [header], scope: statement.parent }, () =>
    read(reading, declaration.initializer),
  );
};

/**
 * Each `assert.<method>(<actual>, <expected>, …)` in `body`, its expected operand read by `read`: one at least, and a
 * second is another record of the same place, new unless the base held its values.
 */
const assertion = (method, actual, describe, read) => (reading, body) => {
  const calls = within(body, (node) => isAssert(node, method, actual));
  if (calls.length === 0) reading.one(calls, `the assertion assert.${method}(${describe}, …)`);
  for (const call of calls) read(call.arguments[1], `assert.${method}(${describe})`);
};

const named = (text) => (node) => node.getText() === text;

/**
 * Where each suite's expected values sit, by the file holding them: `read(reading)`, or `listed` for listed sites.
 */
export const GROUNDS = {
  "tests/type-core-candidate.test.ts": {
    read: (reading) =>
      inTest(
        "an integer-only use of a written number place is the current checker's error at every use",
        assertion("deepEqual", named("units"), "units", (node, place) => reading.row(node, place)),
      )(reading),
  },
  "tests/type-core-closure.test.ts": {
    read: inDeclaration(
      "OUTSIDE",
      (reading) =>
        reading.one(
          declaring(reading.source, "frozen"),
          "the declaration of frozen, OUTSIDE's ground",
        ),
      (reading, node) =>
        reading.array(node, "OUTSIDE", (row) => {
          if (ts.isArrayLiteralExpression(row) && row.elements.length === 3)
            reading.row(row.elements[2], "OUTSIDE's totals");
          else
            reading.refuse(
              row,
              `an OUTSIDE row is ${kindOf(row)}, not a [name, source, totals] row`,
            );
        }),
    ),
  },
  "tests/type-core-contract-capture.test.ts": {
    read: (reading) =>
      inTest(
        "the capture ends at the first store whose contract leaves the slice's depth",
        assertion("equal", named("budget.total"), "budget.total", (node, place) => {
          const value = reading.number(node, place);
          if (value !== undefined) reading.record(place, [value], node);
        }),
      )(reading),
  },
  "tests/type-core-f18.test.ts": {
    read: (reading) =>
      inTest(
        "a literal default keeps the contract's own walk",
        assertion(
          "deepEqual",
          (actual) =>
            ts.isObjectLiteralExpression(actual) && propertyOf(actual, "total") !== undefined,
          "{ total, decisions, default }",
          (node, place) => {
            const values = [];
            const known = reading.object(node, place, {
              total: (value, at) => values.push(reading.number(value, at)),
              decisions: (value, at) => values.push(...(reading.numbers(value, at) ?? [undefined])),
              default: (value, at) => values.push(...(reading.numbers(value, at) ?? [undefined])),
            });
            if (known && !values.includes(undefined)) reading.record(place, values, node);
          },
        ),
      )(reading),
  },
  "tests/type-core-key-ids.test.ts": { listed: true },
  "tests/type-core-kept.test.ts": { listed: true },
  "tests/type-core-work-a.test.ts": {
    read: (reading) =>
      inTest(
        "a long copied key's store check charges its positions' work",
        assertion("deepEqual", named("measured"), "measured", (node, place) =>
          reading.rows(node, place, 2),
        ),
      )(reading),
  },
  "tests/helpers/type-core-families.ts": {
    read: inDeclaration(
      "OUTPUT_BOUND_FAMILIES",
      (reading) =>
        reading.one(
          within(
            reading.source,
            (node) =>
              ts.isPropertySignature(node) &&
              node.name.getText() === "main" &&
              ts.isInterfaceDeclaration(node.parent) &&
              node.parent.name.text === "OutputBoundFamily",
          ),
          "OutputBoundFamily's main, the families' ground",
        ),
      (reading, node) =>
        reading.array(node, "OUTPUT_BOUND_FAMILIES", (family) => {
          if (!ts.isObjectLiteralExpression(family)) {
            reading.refuse(family, `a family is ${kindOf(family)}, not an object literal`);
            return;
          }
          const main = propertyOf(family, "main");
          if (main === undefined) {
            reading.refuse(family, "a family has no main");
            return;
          }
          if (!ts.isObjectLiteralExpression(main.initializer)) {
            reading.refuse(
              main.initializer,
              `a family's main is ${kindOf(main.initializer)}, not an object literal`,
            );
            return;
          }
          for (const size of main.initializer.properties)
            if (ts.isPropertyAssignment(size) && ts.isNumericLiteral(size.name))
              reading.rows(size.initializer, "main", 1);
            else reading.refuse(size, `a family's main holds ${kindOf(size)}, not a numeric size`);
        }),
    ),
  },
  "tests/type-core-work-c.test.ts": {
    read: (reading) => {
      inTest("a deep read asks its one holder's source by reference", (reading, body) =>
        reading.declaredArray(body, "shapes", "the deep read's shapes", (shape) => {
          if (!ts.isObjectLiteralExpression(shape)) {
            reading.refuse(shape, `a shape is ${kindOf(shape)}, not an object literal`);
            return;
          }
          for (const side of ["shared", "unshared"]) {
            const property = propertyOf(shape, side);
            if (property === undefined) reading.refuse(shape, `a shape has no ${side}`);
            else
              reading.object(
                property.initializer,
                side,
                Object.fromEntries(
                  ["total", "invSteps", "checks", "literalUnits", "small"].map((name) => [
                    name,
                    (node, place) => reading.row(node, place),
                  ]),
                ),
              );
          }
          const setup = propertyOf(shape, "setup");
          if (setup === undefined) reading.refuse(shape, "a shape has no setup");
          else reading.row(setup.initializer, "setup");
        }),
      )(reading);
      inTest("a prefix of closed objects read once has main's counters", (reading, body) =>
        reading.declaredArray(body, "cases", "the closed-object prefix's cases", (row) => {
          if (ts.isArrayLiteralExpression(row) && row.elements.length === 3)
            reading.array(row.elements[2], "a case's counters", (snapshot) =>
              reading.counters(snapshot, "a case's counters"),
            );
          else reading.refuse(row, `a case is ${kindOf(row)}, not a [name, source, counters] row`);
        }),
      )(reading);
      inTest(
        "a prefix the cheap checks refuse walks no holder's marks",
        assertion(
          "deepEqual",
          () => true,
          "the four modes' totals",
          (node, place) => reading.row(node, place),
        ),
      )(reading);
    },
  },
};

/** The last readings, since a base is read once for each head compared with it. */
const readings = new Map();

/** The records and refusals of one suite's file. */
export function readingOf(file, text) {
  const key = `${file}\u0000${text}`;
  const kept = readings.get(key);
  if (kept !== undefined) return kept;
  const reading = readFresh(file, text);
  readings.set(key, reading);
  if (readings.size > 4) readings.delete(readings.keys().next().value);
  return reading;
}

function readFresh(file, text) {
  const { source, errors } = parse(file, text);
  const reading = new Reading(source);
  if (errors > 0)
    reading.refusals.push({
      line: lineOf(source, source.parseDiagnostics[0].start),
      what: `the file does not parse (${errors} error${errors === 1 ? "" : "s"})`,
      fix: "Make it parse.",
    });
  else GROUNDS[file].read(reading);
  return reading;
}

/** The comments, as line ranges, each on lines of its own, leading `node`. */
function standaloneComments(source, node) {
  const text = source.text;
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
  return ranges
    .filter(({ pos, end }) => {
      const before = text.slice(text.lastIndexOf("\n", pos - 1) + 1, pos);
      const after = text.slice(
        end,
        text.indexOf("\n", end) === -1 ? text.length : text.indexOf("\n", end),
      );
      return before.trim() === "" && after.trim() === "";
    })
    .map(({ pos, end }) => ({ from: lineOf(source, pos), to: lineOf(source, end) }));
}

/** Where a record's ground may be written: comments leading it or its containers up to its owner, and its header's. */
function groundsOf(source, record) {
  const local = [];
  for (
    let node = record.node;
    node !== undefined && node !== record.owner.scope;
    node = node.parent
  )
    local.push(...standaloneComments(source, node));
  const header = record.owner.header.flatMap((node) => standaloneComments(source, node));
  return { local, header };
}

const linesText = ({ from, to }) => (from === to ? `line ${from}` : `lines ${from}–${to}`);
const signatureOf = (record) =>
  `${record.owner.name}\u0000${record.place}\u0000${record.values.join(",")}`;

/**
 * The refusals of one changed file of a suite's pins, from its base and head texts and the head lines the change
 * added, each one text naming the file, the line, what is refused and the fix.
 */
export function refusalsOf(file, baseText, headText, added) {
  const head = readingOf(file, headText);
  const base = readingOf(file, baseText);
  const out = [];
  if (base.refusals.some(({ what }) => what.startsWith("the file does not parse")))
    out.push(
      `${file}: at the base, the file does not parse.\n  Its pins cannot be compared; check the base you named.`,
    );
  for (const { line, what, fix } of head.refusals) out.push(`${file}:${line}: ${what}.\n  ${fix}`);
  const held = new Map();
  for (const record of base.records)
    held.set(signatureOf(record), (held.get(signatureOf(record)) ?? 0) + 1);
  const changed = new Set(added);
  const touched = ({ from, to }) => {
    for (let line = from; line <= to; line += 1) if (changed.has(line)) return true;
    return false;
  };
  for (const record of head.records) {
    const signature = signatureOf(record);
    if ((held.get(signature) ?? 0) > 0) {
      held.set(signature, held.get(signature) - 1);
      continue;
    }
    const { local, header } = groundsOf(head.source, record);
    if ([...local, ...header].some(touched)) continue;
    const line = lineOf(head.source, record.node.getStart());
    const where = [
      local.length > 0
        ? `in its comment (${local.map(linesText).join(", ")})`
        : "in a comment on its own lines above it",
      ...(header.length > 0 ? [`in its header (${header.map(linesText).join(", ")})`] : []),
    ].join(", or ");
    out.push(
      `${file}:${line}: ${record.place}, new or re-pinned (${record.values.join(", ")}), with no change to its ground.\n` +
        `  Write ${where} how many units more or fewer, and since which change ("N units more since #…").`,
    );
  }
  return out;
}
