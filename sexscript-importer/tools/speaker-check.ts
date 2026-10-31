/**
 * Lists who says each message of converted packages, the check of a unit's speaker data (`patches/<unit>/speakers.json`):
 * each package plays from `main.tease` in the runtime, several times, and every message it shows is listed with its
 * speaker and the picture on screen when it was said.
 *
 * Usage: node tools/speaker-check.ts [--runs N] [--steps N] <package-dir>... > speakers.jsonl
 *
 * A run answers each prompt and goes on until the session halts or fails, or `--steps` answers (default 300) were
 * given. At a choice it takes the option tried least often at that prompt in earlier runs, so later runs take other
 * branches; text and number asks cycle through a few answers; waits, timers, and media pass in simulated time. Each
 * run starts with the storage the previous one left, as a later session does. Runs stop after `--runs` (default 12),
 * or after two runs in a row said no message not said before.
 *
 * One JSON line per package: `{ package, runs, messages, pictures }`, where `runs` gives each run's end and steps, and
 * `messages` each distinct message place with its speaker and picture: `{ path, line, speaker, name, picture, count,
 * text }` (`line` of the converted file, one-based; `speaker` the identifier, `name` the name shown; `text` the
 * first one said there). `pictures` compares speakers with pictures where characters have picture folders of their
 * own: a folder is a character's when at least three message places show it and nine in ten of the characters' places
 * there are hers. Where two characters or more have one, `disagreements` lists each message a character says over
 * another's folder, a data or a legacy picture mistake to review; else `pictures` is null. The importer's `system`,
 * the `narrator`, and the `player` are no characters here.
 */
import path from "node:path";
import { parseArgs } from "node:util";
import { isRecord } from "../src/ast.ts";
import { loadRepositoryPackageScanner } from "../src/compile-check.ts";
import { repositoryBuildUrl } from "../src/repository-build.ts";

type Data = Record<string, unknown>;
interface Session {
  view(): Data;
  stepToEvent(): Data;
  stageProjection(): Data;
  completeAction(request: Data, options?: Data): Data;
  observeTime(nowMs: number, reports: Data[]): Data;
  reportMediaLoad(mediaId: unknown, report: Data): Data;
  mediaPlaybackProjection(): Data[];
  exportSnapshot(): Data;
}
/** How a run ended, and after how many answers. */
interface RunEnd {
  end: "halted" | "failed" | "stuck" | "steps" | "error";
  steps?: number;
  code?: unknown;
  message?: string;
}
interface Message {
  path: string;
  line: number;
  speaker: string | null;
  name: string | null;
  picture: string | null;
  count: number;
  text: string;
}

const NUMBER_ANSWERS = ["1", "3", "0", "10", "5", "2"];
const TEXT_ANSWERS = ["yes", "no", "Mistress", "1", "ok", "slave"];
/** The wall clock at simulated time 0, as the report's smoke runs use it: 2026-10-02 12:00 UTC. */
const EPOCH_MS = Date.UTC(2026, 9, 2, 12, 0, 0);
const MEDIA_PASS_MS = 1000;
/** Events one answer may lead to before the run counts as stuck in a loop without prompts. */
const MAX_EVENTS_PER_STEP = 20_000;

const { values, positionals } = parseArgs({
  options: { runs: { type: "string", default: "12" }, steps: { type: "string", default: "300" } },
  allowPositionals: true,
});
if (positionals.length === 0) {
  process.stderr.write(
    "Usage: node tools/speaker-check.ts [--runs N] [--steps N] <package-dir>...\n",
  );
  process.exit(2);
}
// The sessions have the operations of Session (docs/RUNTIME.md#runtime-sessions).
// EVIDENCE: the repository build's index exports compileProject and createFreshRuntimeSession (src/index.ts).
const engine = (await import(repositoryBuildUrl("src/index.js").href)) as {
  compileProject: (sources: unknown, options: unknown) => Data;
  createFreshRuntimeSession: (plan: Data, fresh: Data, options?: Data) => Session;
};
const scan = await loadRepositoryPackageScanner();
for (const root of positionals) {
  const result = await checkPackage(path.resolve(root), Number(values.runs), Number(values.steps));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function checkPackage(root: string, runs: number, steps: number): Promise<Data> {
  const { sources, images } = await scan(root);
  const compiled = engine.compileProject(sources, { builtins: [], images });
  const plan = isRecord(compiled.plan) ? compiled.plan : null;
  if (plan === null)
    return { package: path.basename(root), compiles: false, runs: [], messages: [] };
  const files = (Array.isArray(plan.files) ? plan.files : []).filter(isRecord);
  const instructions = (Array.isArray(plan.instructions) ? plan.instructions : []).filter(isRecord);
  const fileOf = (instruction: number): string =>
    String(
      files.find(
        (file) =>
          Number(file.startInstruction) <= instruction && instruction < Number(file.endInstruction),
      )?.path ?? "?",
    );
  const messages = new Map<string, Message>();
  const tried = new Map<string, number[]>();
  const ends: RunEnd[] = [];
  let storage: unknown[] = [];
  let quiet = 0;
  for (let run = 0; run < runs && quiet < 2; run += 1) {
    const before = messages.size;
    const session = engine.createFreshRuntimeSession(plan, {
      seed: 12345 + run,
      baseDelayMs: 0,
      delayPerWordMs: 0,
      delayPerCharacterMs: 0,
      scriptStorage: storage,
      wallClockMs: EPOCH_MS,
    });
    const end = play(session, steps, tried, (event, at) => {
      const speaker = isRecord(event.speaker) ? event.speaker : null;
      const span = isRecord(event.span) && isRecord(event.span.start) ? event.span.start : {};
      const picture = session.stageProjection().image;
      const place: Message = {
        path: fileOf(at),
        line: Number(span.line) + 1,
        speaker: speaker === null ? null : String(speaker.identifier),
        name: speaker === null ? null : String(speaker.displayName),
        picture: typeof picture === "string" ? picture : null,
        count: 1,
        text: String(event.text ?? "").slice(0, 120),
      };
      const key = JSON.stringify([
        place.path,
        place.line,
        place.speaker,
        place.name,
        place.picture,
      ]);
      const known = messages.get(key);
      if (known === undefined) messages.set(key, place);
      else known.count += 1;
    });
    ends.push(end);
    try {
      const snapshot = session.exportSnapshot();
      storage = Array.isArray(snapshot.scriptStorage) ? snapshot.scriptStorage : storage;
    } catch {
      // A session that failed exports nothing; the next run keeps the storage it started with.
    }
    quiet = messages.size === before ? quiet + 1 : 0;
  }
  const listed = [...messages.values()].sort(
    (left, right) => left.path.localeCompare(right.path) || left.line - right.line,
  );
  return {
    package: path.basename(root),
    compiles: true,
    runs: ends,
    messages: listed,
    pictures: pictures(listed),
  };

  /** One run: its end, with `said` seeing each message and the instruction that said it. */
  function play(
    session: Session,
    maxSteps: number,
    tried: Map<string, number[]>,
    said: (event: Data, instruction: number) => void,
  ): RunEnd {
    let now = 0;
    const reportedAt = new Map<string, number>();
    const observe = (until: number): void => {
      const reports = session
        .mediaPlaybackProjection()
        .filter((media) => media.state === "running" && media.loaded === true)
        .map((media) => {
          const key = `${String(media.mediaId)}:${String(media.segment)}`;
          const since = reportedAt.get(key) ?? now;
          reportedAt.set(key, until);
          const reported =
            typeof media.reportedProgressMs === "number" ? media.reportedProgressMs : 0;
          return {
            mediaId: media.mediaId,
            segment: media.segment,
            progressMs: reported + until - since,
          };
        });
      now = until;
      session.observeTime(now, reports);
    };
    const advance = (): void => {
      for (let events = 0; session.view().runnable === true; events += 1) {
        if (events > MAX_EVENTS_PER_STEP) throw new Error("no prompt after many events");
        const result = session.stepToEvent();
        const next = Number(session.view().nextInstruction);
        for (const event of (Array.isArray(result.events) ? result.events : []).filter(isRecord))
          if (event.kind === "say") said(event, saidAt(next, event));
      }
    };
    const ended = (step: number): RunEnd | null => {
      const view = session.view();
      if (view.status === "halted") return { end: "halted", steps: step };
      if (view.status !== "failed") return null;
      const failure = isRecord(view.failure) ? view.failure : {};
      return {
        end: "failed",
        steps: step,
        code: failure.code,
        message: String(failure.message ?? "").slice(0, 200),
      };
    };
    try {
      advance();
      for (let step = 0; step < maxSteps; step += 1) {
        const done = ended(step);
        if (done !== null) return done;
        const view = session.view();
        const action = isRecord(view.foregroundAction) ? view.foregroundAction : null;
        if (action === null) return { end: "stuck", steps: step };
        if (action.kind === "capture") {
          session.completeAction({
            actionId: action.actionId,
            actionKind: "capture",
            payload: { kind: "unavailable", reason: "unconfigured" },
          });
        } else if (action.kind === "interaction") {
          session.completeAction(
            {
              actionId: action.actionId,
              actionKind: "interaction",
              interactionKind: action.interactionKind,
              payload: answer(action, tried),
            },
            { capturedMedia: { holds: (reference: string) => reference === "check-image" } },
          );
        } else if (typeof action.deadlineMs === "number") {
          observe(Math.max(now + 1, action.deadlineMs));
        } else {
          const playback = session
            .mediaPlaybackProjection()
            .find((media) => media.mediaId === action.mediaId);
          if (action.kind === "mediaPlayback" && playback !== undefined && playback.loaded !== true)
            session.reportMediaLoad(action.mediaId, { kind: "loaded", durationMs: MEDIA_PASS_MS });
          else observe(now + MEDIA_PASS_MS);
        }
        advance();
      }
      return ended(maxSteps) ?? { end: "steps", steps: maxSteps };
    } catch (error) {
      return { end: "error", message: String(error).slice(0, 200) };
    }
  }

  /** The `say` instruction of an event: the one before where the session stands, else the one at its span. */
  function saidAt(next: number, event: Data): number {
    const span = isRecord(event.span) && isRecord(event.span.start) ? event.span.start : {};
    const at = (index: number): boolean => {
      const instruction = instructions[index];
      const own = instruction !== undefined && isRecord(instruction.span) ? instruction.span : {};
      return instruction?.kind === "say" && own.so === span.offset;
    };
    if (at(next - 1)) return next - 1;
    const found = instructions.findIndex((_, index) => at(index));
    return found < 0 ? next - 1 : found;
  }
}

/** Each character's own picture folder, and the messages a character says over another's (see the usage). */
function pictures(messages: readonly Message[]): Data | null {
  const character = (message: Message): boolean =>
    message.speaker !== null && !["system", "narrator", "player"].includes(message.speaker);
  const folderOf = (message: Message): string | null =>
    message.picture === null ? null : path.posix.dirname(message.picture);
  const byFolder = new Map<string, Map<string, number>>();
  for (const message of messages.filter(character)) {
    const folder = folderOf(message);
    if (folder === null) continue;
    const speakers = byFolder.get(folder) ?? new Map<string, number>();
    byFolder.set(folder, speakers);
    speakers.set(message.speaker!, (speakers.get(message.speaker!) ?? 0) + 1);
  }
  const owners = new Map<string, string>();
  for (const [folder, speakers] of byFolder) {
    const total = [...speakers.values()].reduce((sum, count) => sum + count, 0);
    const [speaker, count] = [...speakers].sort((left, right) => right[1] - left[1])[0]!;
    if (total >= 3 && count * 10 >= total * 9) owners.set(folder, speaker);
  }
  if (new Set(owners.values()).size < 2) return null;
  return {
    owners: Object.fromEntries([...owners].sort()),
    disagreements: messages.filter((message) => {
      const owner = owners.get(folderOf(message) ?? "");
      return character(message) && owner !== undefined && owner !== message.speaker;
    }),
  };
}

/** The answer to a prompt: a button pressed, the choice tried least often there, or the next typed answer. */
function answer(action: Data, tried: Map<string, number[]>) {
  const ui = isRecord(action.ui) ? action.ui : {};
  if (ui.kind === "image") return { kind: "image", reference: "check-image" };
  if (action.interactionKind === "form") return { kind: "submit" };
  const key = String(action.owningInstruction);
  const counts = tried.get(key) ?? [];
  tried.set(key, counts);
  const next = (size: number): number => {
    for (let index = counts.length; index < size; index += 1) counts.push(0);
    let best = 0;
    for (let index = 1; index < size; index += 1) if (counts[index]! < counts[best]!) best = index;
    counts[best]! += 1;
    return best;
  };
  switch (action.interactionKind) {
    case "button":
    case "popup":
      return { kind: "activate" };
    case "url":
      return { kind: "opened" };
    case "export":
      return { kind: "close" };
    case "text":
      return { kind: "submittedText", submittedText: TEXT_ANSWERS[next(TEXT_ANSWERS.length)] };
    case "number":
    case "integer":
      return { kind: "submittedText", submittedText: NUMBER_ANSWERS[next(NUMBER_ANSWERS.length)] };
    default: {
      const options = Array.isArray(ui.options) ? ui.options : [];
      return { kind: "selectedOption", optionIndex: next(Math.max(options.length, 1)) };
    }
  }
}
