// Java and data API rules (src/java-data.ts): real Groovy 2.5.21 parsing, importer lowering, and the real TeaseScript
// compiler and runtime, on small text-only fixtures written per test.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRepositoryProjectCompiler } from "../src/compile-check.ts";
import { emitTease } from "../src/emit-tease.ts";
import { lowerSelfContainedPackage } from "../src/package.ts";
import { loadRepositoryProjectRunner } from "../src/runtime-check.ts";
import { parseGroovySource } from "../src/source-parser.ts";

const parserUnavailable = groovyParserUnavailableReason();
const project = await Promise.all([
  loadRepositoryProjectCompiler(),
  loadRepositoryProjectRunner(),
]).then(
  ([compiler, runner]) => ({ compiler, runner }),
  (error: unknown) => ({ reason: error instanceof Error ? error.message : String(error) }),
);
const skip = parserUnavailable || ("reason" in project ? project.reason : false);

/** Converts Groovy lines as a lone script whose legacy data folder holds `files`, by name and text. */
async function convert(lines: string[], files: Record<string, string> = {}): Promise<string> {
  const directory = mkdtempSync(path.join(tmpdir(), "sexscript-java-"));
  try {
    const sourcePath = path.join(directory, "script.groovy");
    writeFileSync(sourcePath, `${lines.join("\n")}\n`);
    const [program] = lowerSelfContainedPackage([await parseGroovySource(sourcePath)], {
      files: Object.keys(files),
      readFile: (name) => (name in files ? new TextEncoder().encode(files[name]) : null),
    });
    return emitTease(program!);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Compiles the converted script and runs it to the end, returning the values it said: each `say` becomes a call of a
 * recording host function, which shows text as itself and other values as JSON.
 */
function run(source: string): string[] {
  if (!("compiler" in project)) return [];
  const recording = source.replaceAll(/^( *)say (.+)$/gmu, "$1record($2)");
  const files = [{ path: "main.tease", source: recording }];
  const compiled = project.compiler(files, ["record"]);
  assert.deepEqual(
    compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
  );
  const said: string[] = [];
  const result = project.runner(files, {
    record: ([value]) => {
      said.push(typeof value === "string" ? value : JSON.stringify(value));
      return null;
    },
  });
  assert.deepEqual(
    { status: result.status, failure: result.failure },
    { status: "halted", failure: null },
  );
  return said;
}

// Package files that no script writes are part of the package as converted: a File, stream, or reader becomes the path
// text of its file, and reading it calls a generated function holding the file's lines, Properties entries, or INI
// values. readLines() splits at LF, CR, and CRLF without an empty last line; Properties keep their escapes and
// continuations; a literal INI lookup reads its value at conversion time.
test("reads package text files that no script writes as converted", { skip }, async () => {
  const source = await convert(
    [
      "def readtext",
      'readtext = new File("scripts/Quiz/world_q.txt")',
      "def questions = readtext.readLines()",
      'readtext = new File("scripts/Quiz/world_a.txt")',
      "def answers = readtext.readLines()",
      'show("${questions.size()} ${questions[1]} ${answers.size()} ${answers[2]}.")',
      'String lang = "en"',
      'File p = new File(getDataFolder() + "/data/strings_" + lang + ".properties")',
      'if (!p.exists()) p = new File(getDataFolder() + "/data/strings_de.properties")',
      'InputStreamReader reader = new InputStreamReader(new FileInputStream(p), "UTF-8")',
      "Properties props = new Properties()",
      "props.load(reader)",
      "reader.close()",
      'show(props.get("greeting"))',
      'show(props.getProperty("key with space", "none") + " " + props.get("missing"))',
      'def settings = new org.ini4j.Wini(new File("scripts/system/settings.ini"))',
      'def option = "Favourite02"',
      'show(settings.get("Favourites", "Favourite01") + "/" + settings.get("Favourites", option) + "/")',
      // The lines are text, so remove() of one of them removes that value, not a position.
      "def all = questions + answers",
      "def asked = all[0]",
      "all.remove(asked)",
      'show("${all.size()} ${all[0]}")',
    ],
    {
      "Quiz/world_q.txt": "Capital of France?\r\nLargest ocean?\r\n",
      "Quiz/world_a.txt": "Paris\nPacific\n\n",
      "data/strings_en.properties":
        "# comment\ngreeting = Hello \\\n    world\nkey\\ with\\ space: value\\u0021\n",
      "data/strings_de.properties": "greeting=Hallo\n",
      "system/settings.ini": "[Favourites]\nFavourite01 = Domme\nFavourite02=\n",
    },
  );
  assert.match(source, /^readtext = "scripts\/Quiz\/world_q\.txt"$/mu);
  assert.match(source, /^let questions = sexscriptLegacyTextLines\(readtext\)$/mu);
  assert.match(source, /^ {2}return \["Capital of France\?", "Largest ocean\?"\]$/mu);
  assert.match(source, /^let props: string\? dict = dict\{\}$/mu);
  assert.match(source, /^props = sexscriptLegacyProperties\(reader\)$/mu);
  assert.match(source, /NOTE SX_PACKAGE_TEXT_SNAPSHOT/u);
  assert.doesNotMatch(source, /TODO|reader\.close/u);
  assert.match(source, /^all\.remove\(asked\)$/mu);
  assert.deepEqual(run(source), [
    "2 Largest ocean? 3 .",
    "Hello world",
    "value! null",
    "Domme//",
    "4 Largest ocean?",
  ]);
});

// A file that some script of the package writes is no fixed text: its reads stay manual work, which names the write.
test("keeps reads of a package file that a script writes as manual work", { skip }, async () => {
  const source = await convert(
    [
      'new File("scripts/log.txt").append("visit")',
      'def log = new File("scripts/log.txt")',
      "def visits = log.readLines()",
      'def tasks = new File("scripts/tasks.txt").readLines()',
      "def saved = tasks",
      'def target = new File("scripts/" + saved[0])',
      "def markDone = { file -> file.delete() }",
      "markDone(target)",
    ],
    { "log.txt": "visit\n", "tasks.txt": "tasks.txt\n" },
  );
  assert.match(
    source,
    /TODO SX_PACKAGE_TEXT_WRITTEN line 3: The package's scripts may write log\.txt \(script\.groovy:1\)/u,
  );
  // The File handed to markDone() may be any file below scripts/, which a write of unknown origin deletes.
  assert.match(
    source,
    /TODO SX_PACKAGE_TEXT_WRITTEN line 4: The package's scripts may write tasks\.txt \(script\.groovy:8\)/u,
  );
});

// A Calendar or Date is a local date and time: fields count months from 0 and weekdays from Sunday as Java's did, `add`
// adds exact minutes and calendar days, a lenient `set` carries into the date, and Unix milliseconds round-trip. The
// runner's player zone is UTC, so the expected values follow from the epoch milliseconds alone.
test("converts Calendar and Date values to local dates and times", { skip }, async () => {
  const source = await convert([
    "def c = Calendar.getInstance()",
    "c.setTimeInMillis(1791289800123)",
    "c.add(Calendar.MINUTE, 50)",
    "c.add(Calendar.DAY_OF_MONTH, -1)",
    'show("${c.get(Calendar.HOUR_OF_DAY)}:${c.get(Calendar.MINUTE)} ${c.get(Calendar.DAY_OF_WEEK)} ${c.get(Calendar.MONTH)}")',
    "def copy = c.clone()",
    "c.set(Calendar.HOUR_OF_DAY, 1)",
    "c.set(Calendar.SECOND, 5)",
    'show("${c.get(Calendar.DAY_OF_MONTH)} ${copy.get(Calendar.DAY_OF_MONTH)} ${c.after(copy)} ${copy.before(c)}")',
    "Date moment = new Date(1791289800123)",
    "def later = moment + 2",
    'show("${later.getTime() - moment.getTime()} ${later - moment} ${moment.getYear() + 1900} ${moment.getDay()}")',
    'show("${c.getTime().getTime() - moment.getTime()} ${System.currentTimeMillis() > 0}")',
    "Date built = new Date(126, 9, 6, 25, 0, 0)",
    'show("${built.year + 1900}-${built.month + 1}-${built.date} ${built.hours}")',
  ]);
  assert.match(source, /^c = c \+ 50 \* 1 min$/mu);
  assert.match(source, /^c = c - 1 \* 1 day$/mu);
  assert.match(
    source,
    /^c = sexscriptLegacyCalendarTime\(c, 1, c\.minute, c\.second, c\.millisecond\)$/mu,
  );
  assert.match(source, /^let later = moment \+ 2 \* 1 day$/mu);
  assert.match(source, /getTimestamp\(\)\.toMilliseconds\(\) > 0/u);
  assert.match(source, /NOTE SX_DATE_MOMENT/u);
  assert.doesNotMatch(source, /TODO/u);
  assert.deepEqual(run(source), [
    "13:20 2 9",
    "5 5 false false",
    "172800000 2 2026 2",
    "-126595000 true",
    "2026-10-7 1",
  ]);
});

// Groovy changed a Calendar in place, so every variable, list, or record that shares it saw the change; a TeaseScript
// value is a copy, so a write to a Calendar that something else may still share stays manual work.
test("keeps writes to a shared Calendar as manual work", { skip }, async () => {
  const source = await convert([
    "def start = Calendar.getInstance()",
    "def history = [start]",
    "start.add(Calendar.MINUTE, 5)",
    'show("${history.size()}")',
  ]);
  assert.match(source, /TODO SX_CALENDAR_SHARED line 3/u);
});

// Java text, number, and random APIs: URL form encoding of UTF-8 bytes, Math functions within the last digits, Random
// draws from the session's random numbers, character arrays, Groovy's number predicates and overlapping counts, Java
// number conversions, and collection constructors. Expected values follow from the Java and Groovy definitions.
test("converts Java text, number, random, and collection APIs", { skip }, async () => {
  const close = (expression: string, value: string) => `Math.abs(${expression} - ${value}) < 1e-12`;
  const source = await convert([
    'show(URLEncoder.encode("Zoë & Bob", "UTF-8") + " " + URLEncoder.encode("a+b c/d*~", "UTF-8"))',
    `show("\${${close("Math.sqrt(16)", "4")}} \${${close("Math.sqrt(2)", "1.4142135623730951")}} \${${close("Math.log(Math.E)", "1")}} \${${close("Math.log(8) / Math.log(2)", "3")}}")`,
    `show("\${Math.pow(2, 10)} \${${close("Math.pow(9, 0.5)", "3")}} \${Math.pow(2, -2)} \${${close("Math.cos(Math.PI)", "-1")}} \${${close("Math.sin(Math.PI / 2)", "1")}}")`,
    "def rnd = new Random()",
    "def roll = rnd.nextInt(6)",
    'show("${roll >= 0 && roll < 6} ${rnd.nextFloat() < 1} ${rnd.nextGaussian() < 100} ${rnd.nextBoolean() || true} ${Math.random() < 1}")',
    'String code = "abc"',
    "def chars = code.toCharArray()",
    "chars[1] = 'X'",
    "show(String.valueOf(chars))",
    'def t = " 42 "',
    'def u = "4.5e3"',
    "show(\"${t.isInteger()} ${u.isInteger()} ${u.isNumber()} ${'x1'.isNumber()} ${'2147483648'.isInteger()} ${'-2147483648'.isInteger()}\")",
    'String s = "aaaa"',
    "show(\"${s.count('aa')} ${s.count('')} ${'a|b|c|d'.indexOf('|', 2)} ${'abc'.charAt(1)}\")",
    "def total = 17",
    "def diff = -3",
    'show("${total.intdiv(5)} ${(-17).intdiv(5)} ${diff.abs()} ${(2.5).round()} ${(1.005 as double).round(2) == 1} ${(7.9).intValue()}")',
    // A value of unknown type that Groovy read as text, such as a closure parameter, converts as text.
    "def initial = { value -> '' + value.charAt(0) + value.indexOf('|', 2) }",
    "def spare, letters",
    'letters = "hey".toCharArray()',
    'show(initial("x|y|z") + " " + String.valueOf(letters))',
    "def items = new ArrayList<String>()",
    'items.add("x")',
    "def copy = new ArrayList(items)",
    'def seen = new HashSet<String>(["captured", "x"])',
    "show(\"${items.size()} ${copy.size()} ${seen.contains('x')}\")",
  ]);
  assert.match(source, /sexscriptLegacyFormEncode\("Zoë & Bob"\)/u);
  assert.doesNotMatch(source, /TODO|let rnd/u);
  assert.match(source, /^let seen = set\["captured", "x"\]$/mu);
  assert.match(source, /^let chars = code\.split\(""\)$/mu);
  assert.deepEqual(run(source), [
    "Zo%C3%AB+%26+Bob a%2Bb+c%2Fd*%7E",
    "true true true true",
    "1024 true 0.25 true true",
    "true true true true true",
    "aXc",
    "true false true false false true",
    "3 5 3 b",
    "3 -3 3 3 true 7",
    "x3 hey",
    "1 1 true",
  ]);
});

// Text buffers become text that appends and range writes replace, the platform line separator a line break, a (char)
// code its ASCII character, list.add(index, value) an insertion, a `.{a,b}text.{c,d}` match a check of the parts
// around the text, and a File of a fixed add-on path whose existence decides a flag the presence of that file.
test(
  "converts text buffers, character codes, insertions, shape matches, and add-on checks",
  { skip },
  async () => {
    const source = await convert(
      [
        "def endCode = new StringBuffer('OEE52B')",
        'def email = "ab@example.com"',
        'if (email.matches(".{1,50}@.{5,50}")) endCode[1..2] = "XY"',
        'endCode[4..4] = "9"',
        "def builder = new StringBuilder()",
        'builder.append("x")',
        "builder.append(3)",
        // StringBuilder.replace() ends a range past the end at the end of the text.
        'def clamp = new StringBuilder("abcde")',
        'clamp[2..10] = "x"',
        "show(clamp.toString())",
        'def nl = System.getProperty("line.separator")',
        "def letter = String.valueOf((char)(3 + 64))",
        'def scripts = ["a", "b"]',
        'scripts.add(0, "Back")',
        'scripts.add(2, "Mid")',
        "show(\"${endCode.toString()} ${builder.toString()} ${nl.length()} ${letter} ${scripts.join(',')} ${scripts.get(1)}\")",
        "show(\"${'a@b' ==~ /.{1,50}@.{5,50}/} ${'x@y\\nz.com' ==~ /.+@.+/} ${'me@home.org'.matches('.+@.+')}\")",
        'def pack = new File("scripts/DLC/pack1.groovy")',
        'def missing = new File("scripts/DLC/pack2.groovy")',
        "if (pack.exists()) pack = true else pack = false",
        "if (missing.exists()) missing = true else missing = false",
      ],
      { "DLC/pack1.groovy": "// add-on\n" },
    );
    assert.match(
      source,
      /^endCode = "\$\{endCode\.substring\(0, 4\)\}9\$\{endCode\.substring\(min\(5, endCode\.length\)\)\}"$/mu,
    );
    assert.match(source, /^scripts = \["Back"\] \+ scripts$/mu);
    assert.match(source, /^let pack = true$/mu);
    assert.match(source, /^let missing = false$/mu);
    assert.doesNotMatch(source, /TODO/u);
    assert.deepEqual(run(source), ["abx", "OXY59B x3 1 C Back,a,Mid,b a", "false false true"]);
  },
);

// The GregorianCalendar idiom shows seconds as a clock that wraps at midnight, File.getName() is the last part of a
// path with either separator, and `record.action()` calls the closure the record's field holds.
test("converts clock texts, file names, and closures kept in record fields", { skip }, async () => {
  const source = await convert([
    "def maxSessionTime = 3725",
    "def clock = new GregorianCalendar( 0, 0, 0, 0, 0, maxSessionTime, 0 ).time.format( 'HH:mm:ss' )",
    "def wrapped = new GregorianCalendar(0, 0, 0, 25, 0, 5).getTime().format('HH:mm')",
    'def shortName = (new File("images/Room\\\\Sub/bed.jpg")).getName()',
    "def count = 0",
    'def hardSlap = [label: "a hard slap", action: { count = count + 1 }]',
    'def soft = [label: "soft", action: { count = count + 10 }]',
    "def strike = hardSlap",
    "strike.action()",
    "soft.action()",
    'show("${clock} ${wrapped} ${shortName} ${count}")',
    "def rolledDice = [3, 1, 2]",
    "rolledDice = rolledDice.sort()",
    "rolledDice = rolledDice.reverse()",
    "def times = [5, 2, 9]",
    "Collections.sort(times)",
    'def tags = ["a", "b", "c"]',
    "Collections.shuffle(tags)",
    "show(\"${rolledDice.join(',')} ${'abc'.reverse()} ${times.join(',')} ${tags.size()}\")",
  ]);
  assert.match(source, /^sexscriptLegacyCall\(strike\.action, \[\]\)$/mu);
  assert.doesNotMatch(source, /TODO/u);
  assert.match(source, /^times\.sort\(\)$/mu);
  assert.deepEqual(run(source), ["01:02:05 01:00 bed.jpg 11", "3,2,1 cba 2,5,9 3"]);
});

// Every way a script may change a file keeps its reads manual: through another variable, as a rename target, below a
// folder it deletes, as the child of a parent folder, by `text +=`, through `as File`, through a File it derives, or in a
// closure with the File as delegate.
test("keeps reads of files that any write of the package may change", { skip }, async () => {
  const files = { "quiz.txt": "first\n", "tmp.txt": "tmp\n", "data/quiz.txt": "data\n" };
  const writes: Array<[string, string]> = [
    ['def f = new File("scripts/quiz.txt"); def g = f; g.delete()', "scripts/quiz.txt"],
    ['new File("scripts/tmp.txt").renameTo("scripts/quiz.txt")', "scripts/quiz.txt"],
    ['new File("scripts", "quiz.txt").write("x")', "scripts/quiz.txt"],
    ['new File("scripts/data").deleteDir()', "scripts/data/quiz.txt"],
    ['def f = new File("scripts/quiz.txt"); f.text += "x"', "scripts/quiz.txt"],
    ['("scripts/quiz.txt" as File).write("x")', "scripts/quiz.txt"],
    ['new File("scripts/quiz.txt").absoluteFile.text = "x"', "scripts/quiz.txt"],
    ['new File("scripts/quiz.txt").with { write("x") }', "scripts/quiz.txt"],
  ];
  for (const [write, read] of writes) {
    const source = await convert([write, `def lines = new File("${read}").readLines()`], files);
    assert.match(source, /TODO SX_PACKAGE_TEXT_WRITTEN line 2/u, write);
  }
});

// A path from getDataFolder() names a file of the package root; a file the package lacks, a flag that a read may still
// see as a File, an out-of-range Calendar.set(), and a key name alone stay manual or keep the lowering's own form.
test(
  "converts package paths and keeps unproven files, flags, and calendar values manual",
  { skip },
  async () => {
    const source = await convert(
      [
        'def lines = new File("${getDataFolder()}/quiz.txt").readLines()',
        'def none = new File("scripts/none.txt").readLines()',
        'def pack = new File("scripts/addon.txt")',
        "if (pack.exists()) pack = true",
        'if (pack) show("yes")',
        "def c = Calendar.getInstance()",
        "c.set(Calendar.MINUTE, 90)",
        'def menu = [label: "x", trim: { 1 }]',
        'def name = "  a "',
        'def b = new StringBuilder("abcde")',
        'b[2..10] = "x"',
        'def settings = new org.ini4j.Wini(new File("scripts/settings.ini"))',
        'show(lines[0] + " " + name.trim() + " " + b.toString())',
        'show(settings.get("S", "q") + settings.get("S", "c") + settings.get("S", "d"))',
      ],
      { "quiz.txt": "first\n", "settings.ini": '[S]\nq="a"\nc=x ; n\nd=1\nd=2\n' },
    );
    assert.match(source, /^let lines = sexscriptLegacyTextLines\("\$\{""\}\/quiz\.txt"\)$/mu);
    assert.match(source, /TODO SX_PACKAGE_TEXT_MISSING line 2/u);
    assert.doesNotMatch(source, /^let pack = (?:true|false)$/mu);
    assert.match(source, /TODO SX_CALENDAR_SET_RANGE line 7/u);
    assert.match(source, /name\.trim\(\)/u);
    // ini4j 0.5.2 kept quotes and a later ; in a value, and read the last value of a repeated option.
    assert.match(source, /"\\"a\\"" \+ "x ; n" \+ "2"/u);
  },
);

function groovyParserUnavailableReason(): string | false {
  if (spawnSync("java", ["-version"], { stdio: "ignore" }).status !== 0) {
    return "Java is not available for the Groovy 2.5.21 parser helper.";
  }
  const maven = path.join(homedir(), ".m2/repository/org/codehaus/groovy");
  const jars = [
    process.env.SEXSCRIPT_GROOVY_JAR ?? path.join(maven, "groovy/2.5.21/groovy-2.5.21.jar"),
    process.env.SEXSCRIPT_GROOVY_JSON_JAR ??
      path.join(maven, "groovy-json/2.5.21/groovy-json-2.5.21.jar"),
  ];
  const missing = jars.find((jar) => !existsSync(jar));
  return missing === undefined ? false : `Groovy 2.5.21 JAR not found: ${missing}`;
}
