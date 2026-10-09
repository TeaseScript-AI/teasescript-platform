/**
 * A playtest report for a tease's creator, from an explorer report: what the automatic playtester could not reach,
 * grouped by what it would need, the crashes with the steps that lead to each, the loops with no way out, and the code
 * that can never run. It is written in the script's terms (its buttons, answers, visits, and conditions as written),
 * not the explorer's.
 *
 * Usage: node tools/explore-report.ts <out>/<unit>.json [--out <file>]
 *
 * Writes Markdown to `--out`, or to standard output.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isRecord } from "../src/ast.ts";

type Fields = Readonly<Record<string, unknown>>;

/** Missed ways listed per group; the others are counted. */
const ROWS = 10;
/** The play clock a first visit starts at (see the explorer's `EPOCH_MS`). */
const FIRST_VISIT_MS = Date.UTC(2026, 9, 2, 12);

async function main(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { out: { type: "string" } },
  });
  if (positionals.length !== 1) {
    process.stderr.write("Usage: node tools/explore-report.ts <out>/<unit>.json [--out <file>]\n");
    process.exit(2);
  }
  const parsed: unknown = JSON.parse(await readFile(positionals[0]!, "utf8"));
  const markdown = playtestReport(fields(parsed));
  if (values.out === undefined) process.stdout.write(markdown);
  else await writeFile(values.out, markdown);
}

function fields(value: unknown): Fields {
  return isRecord(value) ? value : {};
}

function records(value: unknown): Fields[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function count(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function plural(amount: number, one: string, many = `${one}s`): string {
  return `${amount} ${amount === 1 ? one : many}`;
}

/** A gap of time in words: seconds, minutes, hours, or days. */
function duration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 120) return plural(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 120 && minutes % 60 !== 0) return plural(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 48) return plural(hours, "hour");
  return plural(Math.round(hours / 24), "day");
}

/** One input as a player would do it. */
function playerStep(input: Fields): string {
  const random = records(input.random);
  const luck =
    random.length === 0
      ? ""
      : ` (with ${random.length === 1 ? "a random draw" : "random draws"} coming out a particular way, at ${random
          .map((choice) => `\`${text(choice.site)}\``)
          .join(", ")})`;
  switch (input.kind) {
    case "option":
      return `choose "${text(input.label)}"${luck}`;
    case "button":
      return `press "${text(input.label)}"${count(input.afterMs) > 0 ? ` after ${duration(count(input.afterMs))}` : ""}${luck}`;
    case "press":
      return `press "${text(input.label)}"${luck}`;
    case "text":
      return `type "${text(input.text)}"${luck}`;
    case "image":
      return `give an image${luck}`;
    case "form": {
      const set = Object.entries(fields(input.fields)).map(
        ([field, value]) => `${field} = ${JSON.stringify(value)}`,
      );
      return input.action === "cancel"
        ? `cancel the form${luck}`
        : `submit the form${set.length === 0 ? "" : ` with ${set.join(", ")}`}${luck}`;
    }
    case "wait":
      return `wait${luck}`;
    case "later":
      return `save, and come back ${duration(count(input.afterMs))} later${luck}`;
    case "clock":
      return `continue at ${clockTime(count(input.wallClockMs))}${luck}`;
    default:
      return `${text(input.kind)}${luck}`;
  }
}

/** A clock time as a player reads it, in UTC. */
function clockTime(milliseconds: number): string {
  return `${new Date(milliseconds).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The steps of a path across visits, as a numbered list per visit, with when each visit starts. */
function playerSteps(path: Fields): string[] {
  const visits = [...records(path.earlier), path];
  const lines: string[] = [];
  let before = FIRST_VISIT_MS;
  visits.forEach((visit, index) => {
    const at = typeof visit.wallClockMs === "number" ? visit.wallClockMs : before;
    const when =
      index === 0
        ? `a new player, starting ${clockTime(at)}`
        : `starting ${clockTime(at)}${at > before ? `, ${duration(at - before)} after visit ${index} started` : ""}`;
    before = at;
    lines.push(`   - Visit ${index + 1} (${when}):`);
    const inputs = records(visit.inputs);
    if (inputs.length === 0) lines.push("     - nothing to do: it happens as the visit starts");
    inputs.forEach((input, step) => lines.push(`     ${step + 1}. ${playerStep(input)}`));
  });
  return lines;
}

/** What a missed way depends on, as the report's groups take it, the most telling first. */
const GROUPS: readonly { source: string; title: string; about: string }[] = [
  {
    source: "storage",
    title: "Needs something saved on an earlier visit",
    about:
      "The condition reads a stored value. The playtester played further visits from what earlier ones saved, but not " +
      "far enough to save what this needs.",
  },
  {
    source: "clock",
    title: "Needs a visit at another time or date",
    about:
      "The condition reads the clock. The playtester came back later and at other times of day, but not at a time that " +
      "makes this true.",
  },
  {
    source: "ask",
    title: "Needs a particular typed answer",
    about:
      "The condition compares what the player typed. The playtester also typed the values the script compares with, " +
      "but none reached this.",
  },
  {
    source: "counter",
    title: "Needs a count to reach a value",
    about: "The condition compares a value the script counts up or down.",
  },
  {
    source: "variable",
    title: "Needs a value the script sets",
    about: "The condition compares a value the script sets along the way.",
  },
];

/** A condition that draws at random itself, by the language's random functions (`percentChance`, `.random`, ...). */
function drawsAtRandom(branch: Fields): boolean {
  return /\b(?:chance|percentChance|random\w*)\s*\(|\.random\b/u.test(
    text(fields(branch.condition).text),
  );
}

/** What the playtester found out about a stored value a missed way needs, in words. */
const STORED_REASONS: readonly [RegExp, string][] = [
  [/no explored session stored it/u, "no visit saved the value it needs"],
  [
    /a session from storage that has it did not reach the condition/u,
    "a visit with the needed value saved did not get back to this point",
  ],
  [/best reached: .* after (\d+) sessions?/u, "the closest value took $1 visit(s)"],
];

/** A missed way in one line: where, the condition as written, and what is known of how far play got. */
function missedWay(branch: Fields): string {
  const condition = fields(branch.condition);
  const written = text(condition.text) || "?";
  const shown =
    branch.case === true
      ? `the case \`${written}\``
      : `\`${written}\` being ${branch.missed === "true" ? "true" : "false"}`;
  const behind = count(branch.behindLines);
  const best = fields(branch.best);
  const needs = text(best.needs);
  const value = String(best.value ?? "");
  const known =
    needs === ""
      ? ""
      : best.distance === 0
        ? `; needs ${needs}: a visit had it (${value}) but did not get back to this point`
        : `; needs ${needs}, closest reached: ${value}` +
          (count(best.session) > 1 ? ` (on visit ${count(best.session)})` : "");
  const depends = (Array.isArray(branch.dependsOn) ? branch.dependsOn : []).map(text);
  const reason = STORED_REASONS.find(([pattern]) => pattern.test(text(branch.reason)));
  const found =
    reason === undefined
      ? ""
      : `; ${text(branch.reason)
          .replace(/^.*$/su, (all) => all.replace(/^needs .*?; /u, ""))
          .replace(reason[0], reason[1])}`;
  return (
    `- \`${text(branch.path)}:${count(branch.line)}\`: ${shown}` +
    `${behind > 0 ? `, ${plural(behind, "line")} behind it` : ""}` +
    (known !== ""
      ? known
      : depends.length > 0
        ? `; depends on ${depends.slice(0, 3).join(", ")}${depends.length > 3 ? ` and ${depends.length - 3} more` : ""}`
        : "") +
    (known !== "" ? "" : found)
  );
}

/** The report for one unit's explorer report. */
export function playtestReport(report: Fields): string {
  const unit = text(report.unit);
  const lines = [`# Playtest report: ${unit}`, ""];
  const compile = fields(report.compile);
  if (compile.ok !== true) {
    lines.push("The script does not compile, so it was not played:", "");
    for (const error of Array.isArray(compile.errors) ? compile.errors : [])
      lines.push(`- \`${text(error)}\``);
    return `${lines.join("\n")}\n`;
  }
  const coverage = fields(report.coverage);
  const search = fields(report.search);
  const reach = fields(coverage.reach);
  const crashes = records(report.crashes);
  const traps = records(report.traps);
  const visits = count(search.sessions);
  lines.push(
    `An automatic playtester played this script for ${count(search.operations).toLocaleString("en")} engine steps, over ` +
      `${plural(visits, "visit")}: it pressed every button, picked every option, typed the answers the script compares ` +
      `with, came back later and at other times, and also chose the outcomes of random draws. It reached ` +
      `${count(coverage.visitedLines)} of the ${count(coverage.coverableLines)} lines that can run (${count(coverage.percent)}%).` +
      (search.stoppedBy === "exhausted"
        ? " It tried everything it could think of."
        : " It stopped at its step budget, so more play may reach more."),
    "",
    `- Crashes: ${crashes.length}`,
    `- Loops with no way out: ${traps.length}`,
    `- Lines not reached: ${count(reach.unknown)}${count(reach.clock) > 0 ? `, and ${count(reach.clock)} reached only by setting the clock` : ""}`,
    `- Lines that can never run: ${count(reach.unreachable)}`,
  );
  if (count(reach.chosen) > 0)
    lines.push(
      `- Lines reached only when a random draw came out a particular way: ${count(reach.chosen)} (a player needs luck)`,
    );

  if (crashes.length > 0) {
    lines.push("", "## Crashes", "");
    crashes.forEach((crash, index) => {
      lines.push(
        `${index + 1}. \`${text(crash.code)}\` at \`${text(crash.path)}:${count(crash.line)}\`: ${text(crash.message)}`,
        "",
        "   To see it happen:",
        ...playerSteps(crash),
        "",
        `   Replay: \`${text(crash.replay)}\``,
        "",
      );
    });
  }

  if (traps.length > 0) {
    lines.push("", "## Loops with no way out", "");
    traps.forEach((trap, index) => {
      const where = (Array.isArray(trap.locations) ? trap.locations : [])
        .map((at) => `\`${text(at)}\``)
        .join(", ");
      const shown = [
        ...(Array.isArray(trap.sampleTexts) ? trap.sampleTexts : [])
          .slice(0, 2)
          .map((said) => `"${text(said)}"`),
        ...(Array.isArray(trap.samplePrompts) ? trap.samplePrompts : []).slice(0, 2).map(text),
      ];
      lines.push(
        `${index + 1}. ${trap.kind === "stuck" ? "Nothing to do and nothing happens" : "A loop the player cannot leave"} at ${where || "an unknown place"}` +
          `${shown.length === 0 ? "" : `, showing ${shown.join(", ")}`}.`,
        "",
        "   To get there:",
        ...playerSteps(trap),
        "",
        `   Replay: \`${text(trap.replay)}\``,
        "",
      );
    });
  }

  const missed = records(coverage.unvisitedBranches).filter(
    (branch) => branch.reach !== "unreachable",
  );
  if (missed.length > 0) {
    lines.push(
      "",
      "## What the playtester could not reach",
      "",
      "Each entry is a condition play reached but always took the same way, with the code behind its other way. " +
        "Entries inside a block that was not reached are left out, as reaching the outer one comes first.",
    );
    const listed = new Set<Fields>();
    const group = (title: string, about: string, members: Fields[]) => {
      if (members.length === 0) return;
      const sorted = [...members].sort(
        (left, right) => count(right.behindLines) - count(left.behindLines),
      );
      lines.push("", `### ${title}`, "", about, "", ...sorted.slice(0, ROWS).map(missedWay));
      if (sorted.length > ROWS) lines.push(`- and ${sorted.length - ROWS} more`);
      for (const member of members) listed.add(member);
    };
    group(
      "Behind a random draw",
      "The condition draws at random itself. The playtester also chose the draw's other outcomes, where it could.",
      missed.filter(drawsAtRandom),
    );
    for (const { source, title, about } of GROUPS)
      group(
        title,
        about,
        missed.filter(
          (branch) =>
            !listed.has(branch) && Array.isArray(branch.sources) && branch.sources.includes(source),
        ),
      );
    group(
      "Not reached in this playtest",
      "No input, saved value, time, or answer the playtester could tell was needed; more play may reach these.",
      missed.filter((branch) => !listed.has(branch)),
    );
  }

  const neverRuns = records(coverage.files).flatMap((file) =>
    records(file.unvisited)
      .filter((range) => range.reach === "unreachable")
      .map((range) => ({
        file: text(file.path),
        lines: text(range.lines),
        reason: text(range.reason),
      })),
  );
  if (neverRuns.length > 0) {
    lines.push("", "## Code that can never run", "");
    const reasons = new Map<string, Map<string, string[]>>();
    for (const { file, lines: at, reason } of neverRuns) {
      const files = reasons.get(reason) ?? new Map<string, string[]>();
      files.set(file, [...(files.get(file) ?? []), at]);
      reasons.set(reason, files);
    }
    for (const [reason, files] of reasons) {
      const places = [...files].map(
        ([file, ranges]) => `- \`${file}\`: lines ${ranges.join(", ")}`,
      );
      const explained =
        reason === "no execution path from the session start"
          ? "Nothing leads here from the start: for example code after an `exit` or a `goto`, or a function nothing calls."
          : reason.startsWith("only behind a condition on stored values")
            ? "Only behind a check on saved values that the script's own saves never produce."
            : reason;
      lines.push(`${explained}`, "", ...places, "");
    }
  }
  return `${lines
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trimEnd()}\n`;
}

// Last, so that the constants above exist when it runs.
if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
