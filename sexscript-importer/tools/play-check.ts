/// <reference lib="dom" />
/**
 * Plays converted packages in the real Player through its UI, on several paths per package, and records how far each
 * run got and why it stopped.
 *
 * Usage: node tools/play-check.ts [--base <origin>] [--runs N] [--steps N] [--only id,id] [--again] [--clock dev|fake]
 *   <converted-root> <out-dir>
 *
 * Each package opens in headless Chromium, one browser at a time, from `<origin>` (default
 * `https://agents.home.arpa:4443`, see `serve-catalog.ts`). A run presses buttons, picks choices, types answers, and
 * submits forms until the session halts, fails, hangs, or the step limit ends it. A run that reaches the step limit, or
 * four minutes of real time, is `parked` while new prompts kept appearing (a long or endless tease, to be tried again at a higher limit
 * with `--steps`), and `loops` when the second half of the run only repeated prompts of the first. With `--clock dev` (the default) the package opens at
 * `/player/?dev&package=<id>&time=skip`, whose development time controls (#615) skip waits, timers, pacing, and audio
 * while no input is pending. With `--clock fake`, the fallback, it opens at `/player/?package=<id>` with Playwright's
 * fake clock and media at 16 times speed. A prompt that comes back three times in a row may wait for an answer that
 * takes time, so the runner then lets 30 seconds pass before answering, then 120 and 300 seconds after three more
 * repeats each (+10 s and +1 min presses in the Debug tool's time controls, or fake-clock jumps), noted in the run's path as
 * `[waited 30 s]`; a button that the script times, or after a text that asks for a minimum time, waits before it is
 * pressed. A text prompt that names a format gets an answer in it (formatAnswer). Each run picks, at
 * every choice, the option tried least often in
 * earlier runs, so later runs take other branches; a package stops after a run that reached nothing new, or after a
 * run that hung or used up its steps, which other paths rarely change. A package whose `.tease` files are unchanged
 * since its last check is skipped unless `--again` is given. The session
 * state is read from the Player's mounted Vue tree (read-only), as the Player shows no runtime failure itself.
 *
 * Writes `<out-dir>/<id>/result.json` and a screenshot of where each run stopped.
 * Needs Playwright: `PLAYWRIGHT_CORE` names the `playwright-core` package folder (default: the agent stack's
 * Playwright CLI install).
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";
import { isRecord } from "../src/ast.ts";
import { packageContentHash, parsePlayCheck } from "./catalog.ts";

const PLAYWRIGHT_CORE =
  process.env.PLAYWRIGHT_CORE ?? "/opt/agent-stack/playwright-cli/node_modules/playwright-core";
const NUMBER_ANSWERS = ["1", "3", "0", "10", "5", "2"];
const TEXT_ANSWERS = ["yes", "no", "Mistress", "1", "ok", "slave"];
const ISO_ANSWERS: Readonly<Record<string, string>> = {
  date: "2026-10-05",
  time: "12:00",
  "datetime-local": "2026-10-05T12:00",
};
const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".svg",
  ".tif",
  ".tiff",
]);
const MEDIA_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".mp4", ".webm"]);
/** A run that takes longer in real time ends there, parked or looping like one that reaches the step limit. */
const RUN_TIMEOUT_MS = 240_000;
/** The fake-clock waits before answering a prompt that keeps coming back, one per three repeats. */
const WAIT_STEPS_S = [30, 120, 300];
/** A package's runs end after this much real time, so one long package cannot hold up a batch. */
const PACKAGE_TIMEOUT_MS = 600_000;

/** The parts of Playwright the runner uses. */
interface Page {
  goto(url: string): Promise<void>;
  waitForSelector(selector: string, options: { timeout: number }): Promise<void>;
  click(selector: string, options?: { timeout: number }): Promise<void>;
  fill(selector: string, value: string, options?: { timeout: number }): Promise<void>;
  press(selector: string, key: string, options?: { timeout: number }): Promise<void>;
  evaluate<T>(fn: () => T): Promise<T>;
  screenshot(options: { path: string; timeout?: number }): Promise<void>;
  addInitScript(fn: () => void): Promise<void>;
  clock: {
    install(): Promise<void>;
    runFor(ms: number): Promise<void>;
    fastForward(ms: number): Promise<void>;
  };
  on(event: "pageerror", listener: (error: Error) => void): void;
  waitForEvent(
    event: "filechooser",
    options: { timeout: number },
  ): Promise<{ setFiles(files: string): Promise<void> }>;
}
interface Browser {
  newContext(options: {
    ignoreHTTPSErrors: boolean;
    viewport: { width: number; height: number };
  }): Promise<{ newPage(): Promise<Page>; close(): Promise<void> }>;
  close(): Promise<void>;
}

/** What one look at the Player shows. */
interface PlayerState {
  status: string | null;
  failure: { code: string; message: string; path: string | null; line: number | null } | null;
  /** `interaction:<kind>`, `delay`, `chatPacingGate`, ... */
  foreground: string | null;
  site: string | null;
  delayMs: number | null;
  options: string[];
  composer: { type: string; mode: string } | null;
  file: string | null;
  stageImage: string | null;
  stageShown: boolean;
  media: Array<{ source: string; loaded: boolean }>;
  progress: number;
  lastText: string;
  /** The last three shown texts, for a prompt that quotes what to type. */
  recentText: string;
  scriptFailure: string | null;
  sites: number;
  /** Transcript entries shown so far. */
  entries: number;
  /** A shown text with legacy HTML markup or an HTML entity, which the Player shows as it is written. */
  markup: string | null;
}

export interface RunResult {
  readonly run: number;
  readonly stop: {
    readonly kind:
      | "ended"
      | "empty"
      | "early-end"
      | "error"
      | "hang"
      | "budget"
      | "parked"
      | "loops"
      | "no-start"
      | "unsupported"
      | "harness";
    readonly detail: string;
    /** Where the stop happened: the failing file and line, or the interaction that hung. */
    readonly file: string | null;
    readonly line: number | null;
    /** The runtime error code, such as TSR027. */
    readonly code: string | null;
  };
  readonly steps: number;
  readonly files: readonly string[];
  /** Each interaction of the run as `file:line → answer`, in order. */
  readonly path: readonly string[];
  readonly lastText: string;
  /** Relative to the result's folder. */
  readonly screenshot: string | null;
}

export interface PlayCheckResult {
  readonly id: string;
  readonly checkedAt: string;
  readonly base: string;
  /** Of the package's `.tease` files; a result for other contents is stale. */
  readonly contentHash: string;
  /** The importer commit that converted the played files, from the unit's `.conversion.json` or the root's summary. */
  readonly converter: string | null;
  /** `parked`: every run ran without errors until a limit while new content kept appearing. */
  readonly verdict: "plays" | "stops" | "no-start" | "parked";
  /** The step limit of the runs, which a parked package is tried again above. */
  readonly stepLimit: number;
  readonly summary: string;
  readonly runs: readonly RunResult[];
  readonly coverage: {
    readonly files: readonly string[];
    readonly fileCount: number;
    readonly sites: number;
    readonly siteCount: number;
    readonly choices: number;
  };
  readonly missingImages: readonly string[];
  readonly missingMedia: readonly string[];
  /** Shown texts with legacy HTML markup or entities, up to three. */
  readonly rawMarkup: readonly string[];
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: "string", default: "https://agents.home.arpa:4443" },
    runs: { type: "string", default: "6" },
    steps: { type: "string", default: "300" },
    only: { type: "string" },
    again: { type: "boolean", default: false },
    clock: { type: "string", default: "dev" },
  },
});
if (positionals.length !== 2) {
  process.stderr.write(
    "Usage: node tools/play-check.ts [--base <origin>] [--runs N] [--steps N] [--only id,id] <converted-root> <out-dir>\n",
  );
  process.exit(2);
}
const root = path.resolve(positionals[0]!);
const out = path.resolve(positionals[1]!);
const only = values.only === undefined ? null : new Set(values.only.split(","));
const ids = (await readdir(root, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
  .map((entry) => entry.name)
  .filter((id) => only === null || only.has(id))
  .sort();
// The interfaces above name the part of Playwright's API this runner calls.
// EVIDENCE: playwright-core's main module exports `chromium`, whose launch() resolves to a Browser.
const { chromium } = createRequire(import.meta.url)(PLAYWRIGHT_CORE) as {
  chromium: { launch(): Promise<Browser> };
};
// The picture an askImage prompt gets: a one-pixel PNG.
const answerImage = path.join(tmpdir(), "play-check-answer.png");
await writeFile(
  answerImage,
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const browser = await chromium.launch();
try {
  for (const [index, id] of ids.entries()) {
    // One package's harness failure is reported and the batch goes on.
    const result = await checkPackage(browser, id).catch((error: unknown) => {
      process.stderr.write(`${id}: the check failed: ${String(error)}\n`);
      return null;
    });
    process.stderr.write(
      result === null
        ? `${index + 1}/${ids.length} ${id}: unchanged since its last check\n`
        : `${index + 1}/${ids.length} ${id}: ${result.verdict} - ${result.summary}\n`,
    );
  }
} finally {
  await browser.close();
}

/** Checks a package; `null` when its last check is of the same `.tease` files and `--again` is not given. */
async function checkPackage(browser: Browser, id: string): Promise<PlayCheckResult | null> {
  const folder = path.join(root, id);
  const files = await packageFiles(folder);
  const sources = await Promise.all(
    files
      .filter((item) => item.endsWith(".tease"))
      .map(async (file) => ({
        path: file,
        source: await readFile(path.join(folder, file), "utf8"),
      })),
  );
  const present = new Set(files);
  const timed = timedButtons(sources);
  const outFolder = path.join(out, id);
  if (!values.again) {
    const last = await readFile(path.join(outFolder, "result.json"), "utf8").then(
      (text) => parsePlayCheck(JSON.parse(text)),
      () => null,
    );
    // A parked package is tried again when the step limit rises.
    if (
      last?.contentHash === packageContentHash(sources) &&
      !(last.verdict === "parked" && last.stepLimit < Number(values.steps))
    )
      return null;
  }
  await rm(outFolder, { recursive: true, force: true });
  await mkdir(outFolder, { recursive: true });

  const tries = new Map<string, number[]>();
  const coveredFiles = new Set<string>();
  const coveredSites = new Set<string>();
  const coveredChoices = new Set<string>();
  const missingImages = new Set<string>();
  const missingMedia = new Set<string>();
  const rawMarkup = new Set<string>();
  const runs: RunResult[] = [];
  let siteCount = 0;
  let fileCount = files.filter((item) => item.endsWith(".tease")).length;
  const started = Date.now();
  for (let run = 0; run < Number(values.runs); run += 1) {
    const before = coveredFiles.size + coveredSites.size + coveredChoices.size;
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 900 },
    });
    let result: RunResult;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Each prompt the run answered, by place and options, to tell a long tease from a loop.
    const prompts: Prompt[] = [];
    // The run's answers and steps so far, which a run that ends by a time limit or a failure of the runner keeps.
    const progress: Progress = { taken: [], steps: 0 };
    const screenshot = `run-${run + 1}.png`;
    let page: Page | null = null;
    try {
      page = await context.newPage();
      const opened = page;
      const timedOut = new Promise<RunResult>((resolve) => {
        timer = setTimeout(() => {
          void opened
            .screenshot({ path: path.join(outFolder, screenshot), timeout: 5_000 })
            .then(
              () => screenshot,
              () => null,
            )
            .then((taken) =>
              resolve({
                run,
                stop: limitStop(
                  prompts,
                  `still running after ${RUN_TIMEOUT_MS / 60_000} minutes of real time`,
                ),
                steps: progress.steps,
                files: [],
                path: [...progress.taken],
                lastText: "",
                screenshot: taken,
              }),
            );
        }, RUN_TIMEOUT_MS);
      });
      const playing = playOnce(page, id, run, outFolder, {
        tries,
        prompts,
        progress,
        timed,
        seen: (state) => {
          siteCount = Math.max(siteCount, state.sites);
          if (state.file !== null) coveredFiles.add(state.file);
          if (state.site !== null) coveredSites.add(state.site);
          if (state.stageImage !== null && !state.stageShown && !present.has(state.stageImage))
            missingImages.add(state.stageImage);
          for (const media of state.media)
            if (!present.has(media.source)) missingMedia.add(media.source);
          if (state.markup !== null && rawMarkup.size < 3) rawMarkup.add(state.markup);
        },
        chose: (site, option) => coveredChoices.add(`${site}#${option}`),
      });
      // Closing the context ends a run that timed out; its rejection then has no reader.
      playing.catch(() => undefined);
      result = await Promise.race([playing, timedOut]);
    } catch (error) {
      // The page could not open or play at all; what the run did before is kept.
      const taken =
        page === null
          ? null
          : await page.screenshot({ path: path.join(outFolder, screenshot), timeout: 5_000 }).then(
              () => screenshot,
              () => null,
            );
      result = {
        run,
        stop: {
          kind: "harness",
          detail: error instanceof Error ? error.message.split("\n")[0]! : String(error),
          file: null,
          line: null,
          code: null,
        },
        steps: progress.steps,
        files: [],
        path: [...progress.taken],
        lastText: "",
        screenshot: taken,
      };
    } finally {
      clearTimeout(timer);
      // A context the browser already dropped cannot be closed again; that must not end the batch.
      await context.close().catch(() => undefined);
    }
    runs.push(result);
    if (Date.now() - started > PACKAGE_TIMEOUT_MS) break;
    if (
      ["no-start", "empty", "hang", "budget", "parked", "loops", "harness"].includes(
        result.stop.kind,
      )
    )
      break;
    if (run > 0 && coveredFiles.size + coveredSites.size + coveredChoices.size === before) break;
  }
  fileCount = Math.max(fileCount, coveredFiles.size);
  const notEnded = runs.find((item) => item.stop.kind !== "ended");
  const verdict =
    runs[0]?.stop.kind === "no-start"
      ? "no-start"
      : notEnded === undefined
        ? "plays"
        : runs.every((item) => item.stop.kind === "ended" || item.stop.kind === "parked")
          ? "parked"
          : "stops";
  const media = [
    ...(missingImages.size > 0 ? [`${missingImages.size} missing images`] : []),
    ...(missingMedia.size > 0 ? [`${missingMedia.size} missing audio/video`] : []),
    ...(rawMarkup.size > 0 ? ["raw HTML in its text"] : []),
  ];
  const summary =
    (verdict === "plays"
      ? `plays to the end in ${runs.length} runs`
      : `run ${notEnded!.run + 1}: ${notEnded!.stop.kind}: ${notEnded!.stop.detail}`) +
    (media.length > 0 ? `; ${media.join(", ")}` : "");
  const result: PlayCheckResult = {
    id,
    checkedAt: new Date().toISOString(),
    base: values.base,
    contentHash: packageContentHash(sources),
    converter: await converterOf(folder),
    stepLimit: Number(values.steps),
    verdict,
    summary,
    runs,
    coverage: {
      files: [...coveredFiles].sort(),
      fileCount,
      sites: coveredSites.size,
      siteCount,
      choices: coveredChoices.size,
    },
    missingImages: [...missingImages].sort(),
    missingMedia: [...missingMedia].sort(),
    rawMarkup: [...rawMarkup],
  };
  await writeFile(path.join(outFolder, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

async function playOnce(
  page: Page,
  id: string,
  run: number,
  outFolder: string,
  track: {
    tries: Map<string, number[]>;
    prompts: Prompt[];
    progress: Progress;
    /** The buttons whose press the script times (timedButtons). */
    timed: ReadonlySet<string>;
    seen(state: PlayerState): void;
    chose(site: string, option: number): void;
  },
): Promise<RunResult> {
  const files = new Set<string>();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const dev = values.clock !== "fake";
  if (!dev) {
    await page.addInitScript(() => {
      // Media play at 16 times speed, so a script that waits for a sound does not wait in real time.
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
        this.playbackRate = 16;
        return play.call(this);
      };
    });
    await page.clock.install();
  }
  const target = encodeURIComponent(id);
  await page.goto(
    dev
      ? `${values.base}/player/?dev&package=${target}&time=skip`
      : `${values.base}/player/?package=${target}`,
  );
  // Time passes: with the time controls, auto-skip jumps on its own, so the runner only gives it a moment.
  const idle = (ms: number) =>
    dev
      ? new Promise((resolve) => setTimeout(resolve, Math.min(ms, 150)))
      : page.clock.fastForward(ms);
  // The +10 s and +1 min buttons live in the Debug tool (#624), which a session that already ended may not open.
  let debugOpen = false;
  const openDebug = async (): Promise<boolean> => {
    if (!debugOpen)
      debugOpen = await page.click('button[aria-label="Debug"]', { timeout: 5_000 }).then(
        () => true,
        () => false,
      );
    return debugOpen;
  };
  // Time passes while a prompt waits for an answer: +1 min and +10 s presses, or a fake-clock jump. Whether it passed.
  const pass = async (seconds: number): Promise<boolean> => {
    if (!dev) {
      await page.clock.fastForward(seconds * 1_000);
      return true;
    }
    if (!(await openDebug())) return false;
    const presses = [
      ...Array.from({ length: Math.floor(seconds / 60) }, () => "advance-1min"),
      ...Array.from({ length: Math.ceil((seconds % 60) / 10) }, () => "advance-10s"),
    ];
    for (const action of presses)
      if (
        !(await page.click(`[data-development-time-action="${action}"]`, { timeout: 5_000 }).then(
          () => true,
          () => false,
        ))
      )
        return false;
    return true;
  };
  await page.waitForSelector("[data-session-activation] button, [data-script-failure]", {
    timeout: 30_000,
  });
  let state = await readState(page);
  const taken = track.progress.taken;
  const finish = async (
    kind: RunResult["stop"]["kind"],
    detail: string,
    steps: number,
    where: { file: string | null; line: number | null; code: string | null } = {
      file: null,
      line: null,
      code: null,
    },
  ): Promise<RunResult> => {
    const screenshot = `run-${run + 1}.png`;
    const shot = await page
      .screenshot({ path: path.join(outFolder, screenshot), timeout: 10_000 })
      .then(
        () => screenshot,
        () => null,
      );
    return {
      run,
      stop: { kind, detail, ...where },
      steps,
      files: [...files].sort(),
      path: taken,
      lastText: state.lastText,
      screenshot: shot,
    };
  };
  // How a session that halted ended.
  const halted = (step: number): Promise<RunResult> => {
    if (step === 0 && state.entries === 0 && state.stageImage === null)
      return finish("empty", "the session ended without showing anything", step);
    // For example a script that needs legacy settings, such as owned toys, that a fresh player does not have.
    if (step === 0 && state.sites > 0)
      return finish("early-end", `ended before its first interaction: "${state.lastText}"`, step);
    return finish("ended", "the session reached its end", step);
  };
  if (state.scriptFailure !== null) return finish("no-start", state.scriptFailure, 0);
  await page.click("[data-session-activation] button");
  // A session without interactions may end at once, before the Debug tool opens, and its end dialog then covers the
  // page; the loop below reads the end.
  state = await readState(page);
  if (dev && state.status !== "halted" && state.status !== "failed") await openDebug();
  const visits = new Map<string, number>();
  // The prompt answered last, how often in a row, and how many waits that streak has had.
  let repeated = { key: "", count: 0, waits: 0 };
  let unchanged = 0;
  let lastProgress = -1;
  let progressAt = Date.now();
  // Answers whose control could not be used, in a row: the state is read again, as the session may have moved on.
  let missed = 0;
  let step = 0;
  // Runs one answer; one whose control cannot be used is tried again after the state is read again.
  const answer = async (what: string, act: () => Promise<void>): Promise<RunResult | null> => {
    try {
      await act();
      missed = 0;
      step += 1;
      return null;
    } catch (error) {
      missed += 1;
      taken.pop();
      if (missed < 4) return null;
      return finish(
        "harness",
        `${what} could not be answered: ${error instanceof Error ? error.message.split("\n")[0]! : String(error)}`,
        step,
      );
    }
  };
  try {
    while (step < Number(values.steps)) {
      track.progress.steps = step;
      state = await readState(page);
      track.seen(state);
      if (state.file !== null) files.add(state.file);
      if (state.status === "halted") return await halted(step);
      if (state.status === "failed" || state.failure !== null) {
        const failure = state.failure;
        return await finish(
          "error",
          failure === null
            ? "the session failed"
            : `${failure.path ?? ""}${failure.line === null ? "" : `:${failure.line}`} ${failure.code} ${failure.message}`.trim(),
          step,
          failure === null
            ? undefined
            : { file: failure.path, line: failure.line, code: failure.code },
        );
      }
      if (pageErrors.length > 0) return await finish("error", `page error: ${pageErrors[0]}`, step);
      if (state.progress === lastProgress) unchanged += 1;
      else {
        unchanged = 0;
        progressAt = Date.now();
      }
      lastProgress = state.progress;
      // About 20 minutes of skipped time and half a minute of real time, for media, without any new event.
      if (unchanged > 60 && Date.now() - progressAt > 30_000)
        return await finish(
          "hang",
          `nothing happens while waiting for ${state.foreground ?? "nothing"}`,
          step,
          {
            file: state.site?.slice(0, state.site.lastIndexOf(":")) ?? state.file,
            line:
              state.site === null
                ? null
                : Number(state.site.slice(state.site.lastIndexOf(":") + 1)),
            code: null,
          },
        );
      if (state.foreground?.startsWith("interaction:") === true && state.site !== null) {
        const site = state.site;
        const kind = state.foreground.slice("interaction:".length);
        const visit = visits.get(site) ?? 0;
        visits.set(site, visit + 1);
        // A script may time how long its prompt stays unanswered, as in "beg for at least 15 seconds". The same place
        // with the same options and text counts as the same prompt; a loop over questions, such as toys, does not.
        const key = `${site}\u0000${state.options.join("\u0000")}\u0000${state.lastText}`;
        if (missed === 0)
          track.prompts.push({
            key: `${site}\u0000${state.options.join("\u0000")}`,
            text: state.lastText,
          });
        repeated =
          key === repeated.key
            ? { ...repeated, count: repeated.count + 1 }
            : { key, count: 1, waits: 0 };
        if (
          repeated.count >= 3 &&
          repeated.waits < WAIT_STEPS_S.length &&
          (state.options.length > 0 || state.composer !== null)
        ) {
          const seconds = WAIT_STEPS_S[repeated.waits]!;
          if (await pass(seconds)) taken.push(`[waited ${seconds} s]`);
          repeated = { key, count: 0, waits: repeated.waits + 1 };
        }
        // A button whose press the script times, or after a text that asks for a minimum time, is pressed after it.
        const minimum =
          kind === "button" ? buttonWait(state.recentText, track.timed.has(site)) : null;
        if (minimum !== null && missed === 0 && (await pass(minimum)))
          taken.push(`[waited ${minimum} s]`);
        let stopped: RunResult | null = null;
        if ((kind === "button" || kind === "choice") && state.options.length > 0) {
          const counts = track.tries.get(site) ?? new Array<number>(state.options.length).fill(0);
          track.tries.set(site, counts);
          // The option tried least often so far; among equals, a run- and visit-dependent one, so loops vary too.
          const order = state.options.map((_, index) => index);
          const offset = (run + visit) % state.options.length;
          order.sort(
            (left, right) =>
              (counts[left] ?? 0) - (counts[right] ?? 0) ||
              ((left - offset + order.length) % order.length) -
                ((right - offset + order.length) % order.length),
          );
          const option = order[0]!;
          taken.push(`${site} → ${state.options[option] ?? option}`);
          stopped = await answer(`the ${kind} at ${site}`, async () => {
            await page.click(`[data-foreground-controls] button >> nth=${option}`, {
              timeout: 5_000,
            });
            counts[option] = (counts[option] ?? 0) + 1;
            track.chose(site, option);
          });
        } else if (kind === "image") {
          // askImage: the composer's attach button opens a file picker, which gets the answer picture.
          taken.push(`${site} → [picture]`);
          stopped = await answer(`the picture at ${site}`, async () => {
            const [chooser] = await Promise.all([
              page.waitForEvent("filechooser", { timeout: 5_000 }),
              page.click("[data-composer-attach]", { timeout: 5_000 }),
            ]);
            await chooser.setFiles(answerImage);
          });
        } else if (kind === "form" && state.options.length > 0) {
          // A form, such as the legacy profile's toggles of owned toys and clothes: every other run switches all
          // toggles on, the others keep them as offered; then it is submitted, the first of the form's actions.
          // A typed field the form requires and the check would have to fill, or an open field editor, is not handled.
          const blocked = await page.evaluate(
            () =>
              document.querySelector("[data-form-fields] [data-editing]") !== null ||
              [...document.querySelectorAll("[data-form-fields] button")].some(
                (button) => button.textContent?.trim().endsWith("Set…") === true,
              ),
          );
          if (blocked)
            return await finish("unsupported", "a form with a required typed field", step);
          const allOn = run % 2 === 1;
          taken.push(`${site} → [form${allOn ? ", all on" : ""}]`);
          stopped = await answer(`the form at ${site}`, async () => {
            if (allOn) {
              const off = await page.evaluate(
                () =>
                  document.querySelectorAll("[data-form-fields] button[data-state='off']").length,
              );
              for (let index = 0; index < off; index += 1)
                await page.click("[data-form-fields] button[data-state='off'] >> nth=0", {
                  timeout: 5_000,
                });
            }
            await page.click("[data-form-actions] button >> nth=0", { timeout: 5_000 });
          });
        } else if (state.composer !== null) {
          const numeric = state.composer.mode === "numeric" || state.composer.mode === "decimal";
          const answers = numeric ? NUMBER_ANSWERS : TEXT_ANSWERS;
          // A prompt that quotes a sentence, as in a lines game ("Write 'I will obey' ten times"), gets that sentence.
          // Or one that names it after "Type:" or "Write:" at the end of a line.
          const quoted = numeric ? undefined : quotedAnswer(state.recentText);
          const text =
            ISO_ANSWERS[state.composer.type] ??
            formatAnswer(state.recentText, run + visit) ??
            quoted ??
            answers[(run + visit) % answers.length]!;
          taken.push(`${site} → "${text}"`);
          stopped = await answer(`the text field at ${site}`, async () => {
            await page.fill("[data-composer-input]", text, { timeout: 5_000 });
            await page.press("[data-composer-input]", "Enter", { timeout: 5_000 });
          });
        } else if (kind !== "button" && kind !== "choice" && unchanged > 3) {
          return await finish("unsupported", `no control for the ${kind} interaction`, step);
        }
        if (stopped !== null) return stopped;
        await idle(300);
      } else if (state.foreground === "delay" && state.delayMs !== null) {
        // Jumping fires each due timer once, instead of every animation frame on the way.
        await idle(Math.max(50, state.delayMs + 50));
      } else {
        // Media play in real time; everything else waits on the fake clock.
        if (state.foreground === "media") await new Promise((resolve) => setTimeout(resolve, 250));
        // Auto-skip pauses while media load, which a missing file never finishes; "Skip event" still jumps then.
        if (dev && unchanged > 2)
          await page
            .click('[data-development-time-action="skip"]:not([disabled])', { timeout: 1_000 })
            .catch(() => undefined);
        await idle(unchanged > 2 ? 20_000 : 1_000);
      }
    }
  } catch (error) {
    // A step the runner could not take: the session may have ended meanwhile, which is then its result.
    state = await readState(page).catch(() => state);
    if (state.status === "halted") return await halted(step);
    return await finish(
      "harness",
      error instanceof Error ? error.message.split("\n")[0]! : String(error),
      step,
    );
  }
  track.progress.steps = step;
  const limit = limitStop(track.prompts, `${values.steps} interactions without reaching the end`);
  return finish(limit.kind, limit.detail, Number(values.steps), limit);
}

/** A prompt a run answered: its place and options, which tell a loop from a long tease, and its last text. */
interface Prompt {
  readonly key: string;
  readonly text: string;
}

/** A run's answers and steps so far. */
interface Progress {
  readonly taken: string[];
  steps: number;
}

/**
 * How a run that reached a limit ended: `loops` when the prompts of its second half, by place and options, all
 * appeared in its first half, with the most repeated ones, else `parked`, as a long tease that kept showing new
 * prompts. A text that changes, such as a score or a hand of cards, does not make a prompt new.
 */
function limitStop(
  prompts: readonly Prompt[],
  limit: string,
): {
  kind: "parked" | "loops";
  detail: string;
  file: string | null;
  line: number | null;
  code: null;
} {
  const half = Math.floor(prompts.length / 2);
  const earlier = new Set(prompts.slice(0, half).map((prompt) => prompt.key));
  const fresh = new Set(
    prompts
      .slice(half)
      .map((prompt) => prompt.key)
      .filter((key) => !earlier.has(key)),
  );
  if (prompts.length < 20 || fresh.size > 0)
    return {
      kind: "parked",
      detail: `${limit}; new prompts kept appearing (${fresh.size} new in the second half)`,
      file: null,
      line: null,
      code: null,
    };
  const counts = new Map<string, { count: number; text: string }>();
  for (const prompt of prompts.slice(half))
    counts.set(prompt.key, { count: (counts.get(prompt.key)?.count ?? 0) + 1, text: prompt.text });
  const repeated = [...counts].sort((left, right) => right[1].count - left[1].count).slice(0, 3);
  const shown = repeated.map(([key, { count, text }]) => {
    const [site, ...options] = key.split("\u0000");
    return `${site} "${text.slice(0, 60)}" [${options.join(" / ")}] ×${count}`;
  });
  const top = repeated[0]?.[0].split("\u0000")[0] ?? "";
  const colon = top.lastIndexOf(":");
  return {
    kind: "loops",
    detail: `${limit}; the second half only repeats earlier prompts: ${shown.join("; ")}`,
    file: colon < 0 ? null : top.slice(0, colon),
    line: colon < 0 ? null : Number(top.slice(colon + 1)),
    code: null,
  };
}

/** A sentence that a prompt quotes, or names after "Type:" or "Write:" at the end of a line, to type. */
function quotedAnswer(text: string): string | undefined {
  return (
    [...text.matchAll(/["'“„«]([^"'“”„«»\n]{3,200})["'”“»]/gu)].at(-1)?.[1] ??
    [
      ...text.matchAll(
        /(?:^|\n)\s*(?:type|write|copy|schreibe|tippe)\s*:\s*([^\n]{3,200}?)\s*$/gimu,
      ),
    ].at(-1)?.[1]
  );
}

/**
 * An answer in the format that a prompt asks for, different on each visit `n`, or null: a cell in a range such as
 * "(A1 to G7)"; a number of "N digits", all different and without a leading 0 where the prompt rules that out; on an
 * optional field nothing every other visit; a URL; or, where the prompt names a number "to quit", one of the numbers it
 * names, so that the quit comes within a few visits.
 */
export function formatAnswer(text: string, n: number): string | null {
  const cells = /\b([A-Z])(\d{1,2})\s*(?:to|-|–)\s*([A-Z])(\d{1,2})\b/u.exec(text);
  if (cells !== null) {
    const [first, last] = [cells[1]!.charCodeAt(0), cells[3]!.charCodeAt(0)];
    const [low, high] = [Number(cells[2]), Number(cells[4])];
    const columns = last - first + 1;
    const rows = high - low + 1;
    if (columns > 0 && rows > 0) {
      // A step that shares no factor with the number of cells visits each cell once before any comes back.
      const total = columns * rows;
      let stride = 7;
      while (gcd(stride, total) !== 1) stride += 1;
      const cell = (n * stride) % total;
      return `${String.fromCharCode(first + (cell % columns))}${low + Math.floor(cell / columns)}`;
    }
  }
  const digits =
    /\b(?:is|exactly|has|have|a|of|enter|input)\s+(\d{1,2})[\s-]*digits?\b/iu.exec(text) ??
    /\b(\d{1,2})-digit\b/iu.exec(text);
  if (digits !== null) {
    const length = Number(digits[1]);
    const noZero = /(?:begin|start)s?\s+with\s+(?:a\s+)?(?:0|zero)/iu.test(text);
    if (length > 0 && length <= 10) {
      // Different digits fit a rule against repeated ones too.
      let answer = "";
      for (let index = 0; answer.length < length; index += 1) {
        const digit = String((n + index + (noZero ? 1 : 0)) % 10);
        if ((answer === "" && noZero && digit === "0") || answer.includes(digit)) continue;
        answer += digit;
      }
      return answer;
    }
  }
  if (/\(optional\)/iu.test(text) && n % 2 === 0) return "";
  if (/\burl\b|web\s*address/iu.test(text)) return "http://example.com/";
  if (/\b\d+\s+to\s+(?:quit|exit|stop|end)\b/iu.test(text)) {
    const named = [...new Set([...text.matchAll(/\b\d+\b/gu)].map((match) => match[0]))];
    return named[n % named.length]!;
  }
  return null;
}

function gcd(left: number, right: number): number {
  return right === 0 ? left : gcd(right, left % right);
}

/**
 * How long to wait before pressing a button: the minimum a text before it asks for, "at least 15 seconds" or "longer
 * than 5 seconds", plus one, or 10 seconds where the script times the press (timedButtons); else null.
 */
function buttonWait(text: string, timed: boolean): number | null {
  const asked =
    /\b(?:at least|longer than|more than|minimum of|no less than)\s+(\d+)\s*(seconds?|secs?|minutes?|mins?)\b/iu.exec(
      text,
    );
  if (asked !== null) {
    const amount = Number(asked[1]);
    return (/^min/iu.test(asked[2]!) ? amount * 60 : amount) + 1;
  }
  return timed ? 10 : null;
}

/**
 * The buttons, `file:line`, whose press a script times: the line that shows the button, or one of the two after it,
 * reads the clock, or the button's elapsed time is used as a value. A button with a timeout is left out, as waiting
 * would let it expire.
 */
function timedButtons(sources: ReadonlyArray<{ path: string; source: string }>): Set<string> {
  const sites = new Set<string>();
  for (const { path: file, source } of sources) {
    const lines = source.split("\n");
    lines.forEach((line, index) => {
      if (!/\bshowButton\b/u.test(line) || /\btimeout:/u.test(line)) return;
      const following = [line, ...lines.slice(index + 1, index + 3)].join("\n");
      if (/getAbsoluteDateTime\(|\(showButton\b[^)]*\)\s*\/|=\s*showButton\b/u.test(following))
        sites.add(`${file}:${index + 1}`);
    });
  }
  return sites;
}

/** Reads the session from the Player's mounted Vue tree and the controls from the page. */
function readState(page: Page): Promise<PlayerState> {
  return page.evaluate(() => {
    type Session = {
      plan: {
        files: Array<{ path: string; startInstruction: number; endInstruction: number }>;
        instructions: Array<{ kind: string; span?: { sl: number } }>;
      };
      // The published runtime state (#685): the session view with the Stage and its active media.
      state: {
        status: string;
        failure: {
          code: string;
          message: string;
          path?: string;
          span?: { start?: { line: number } };
        } | null;
        foregroundAction: {
          kind: string;
          interactionKind?: string;
          owningInstruction?: number;
          deadlineMs?: number;
        } | null;
        currentSessionTimeMs: number;
        nextInstruction: number;
        stage: { image: string | null };
        media: Array<{ source: string; loaded: boolean }>;
      };
      events: Array<{ sequence: number }>;
      transcriptEntries: Array<{ text?: string }>;
    };
    type MountedRoot = {
      component?: {
        subTree?: { component?: { props?: { player?: { session?: { value: Session | null } } } } };
      };
    };
    // The Player's root renders PlayerApp, whose `player` prop is the session host with the published session.
    // EVIDENCE: Vue's renderer keeps the mounted root vnode on its container element as `_vnode`.
    const app = document.querySelector("#app") as (Element & { _vnode?: MountedRoot }) | null;
    const root = app?._vnode;
    const session = root?.component?.subTree?.component?.props?.player?.session?.value ?? null;
    const view = session?.state;
    const fileOf = (instruction: number | undefined) =>
      instruction === undefined
        ? null
        : (session?.plan.files.find(
            (file) => instruction >= file.startInstruction && instruction < file.endInstruction,
          )?.path ?? null);
    const action = view?.foregroundAction ?? null;
    const site =
      action?.kind !== "interaction" || action.owningInstruction === undefined
        ? null
        : `${fileOf(action.owningInstruction)}:${(session?.plan.instructions[action.owningInstruction]?.span?.sl ?? -1) + 1}`;
    const composer = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(
      "[data-composer-input]",
    );
    const stage = document.querySelector<HTMLImageElement>(".stage-media");
    const stageImage = view?.stage.image ?? null;
    const media = (view?.media ?? []).map((item) => ({ source: item.source, loaded: item.loaded }));
    const frameFile = fileOf(view?.nextInstruction);
    return {
      status: view?.status ?? null,
      failure:
        view?.failure == null
          ? null
          : {
              code: view.failure.code,
              message: view.failure.message,
              path: view.failure.path ?? null,
              line:
                view.failure.span?.start === undefined ? null : view.failure.span.start.line + 1,
            },
      foreground:
        action === null
          ? null
          : action.kind === "interaction"
            ? `interaction:${action.interactionKind}`
            : action.kind,
      site,
      delayMs:
        action?.kind === "delay" && action.deadlineMs !== undefined && view !== undefined
          ? action.deadlineMs - view.currentSessionTimeMs
          : null,
      options: [...document.querySelectorAll("[data-foreground-controls] button")].map(
        (button) => button.textContent?.trim() ?? "",
      ),
      composer:
        composer === null ||
        composer.disabled ||
        document.querySelector("[data-foreground-controls]") !== null
          ? null
          : {
              type: composer.getAttribute("type") ?? "text",
              mode: composer.getAttribute("inputmode") ?? "text",
            },
      file: frameFile ?? fileOf(action?.owningInstruction),
      stageImage,
      stageShown: stage !== null && stage.complete && stage.naturalWidth > 0,
      media,
      progress:
        (session?.events.at(-1)?.sequence ?? 0) * 1000 + (session?.transcriptEntries.length ?? 0),
      lastText: (session?.transcriptEntries.at(-1)?.text ?? "").slice(0, 200),
      recentText: (session?.transcriptEntries.slice(-3) ?? [])
        .map((entry) => entry.text ?? "")
        .join("\n"),
      entries: session?.transcriptEntries.length ?? 0,
      markup: (() => {
        const pattern = /<[A-Za-z/][^>]*>|&(?:quot|amp|lt|gt|apos|nbsp|#\d+);?/u;
        for (const entry of session?.transcriptEntries ?? []) {
          const match = pattern.exec(entry.text ?? "");
          if (match !== null)
            return (entry.text ?? "").slice(Math.max(0, match.index - 20), match.index + 60);
        }
        return null;
      })(),
      scriptFailure: (() => {
        const panel = document.querySelector("[data-script-failure]");
        if (panel === null) return null;
        // Each listed problem is its location and message; warnings do not keep a script from starting.
        const errors = [...panel.querySelectorAll("li")]
          .map((item) =>
            [...item.querySelectorAll("span")].map((span) => span.textContent?.trim() ?? ""),
          )
          .filter((parts) => !parts.some((part) => part.startsWith("Warning: ")))
          .map((parts) => parts.join(" "));
        return errors.length === 0
          ? (panel.textContent?.trim().slice(0, 500) ?? "")
          : `${errors.slice(0, 3).join(" | ")}${errors.length > 3 ? ` (${errors.length} errors)` : ""}`;
      })(),
      sites:
        session?.plan.instructions.filter((instruction) => instruction.kind === "interaction")
          .length ?? 0,
    };
  });
}

/** The importer commit of a converted unit: its own `converter`, else the root summary's `importerCommit`. */
async function converterOf(folder: string): Promise<string | null> {
  for (const [file, field] of [
    [path.join(folder, ".conversion.json"), "converter"],
    [path.join(folder, "..", ".conversion-summary.json"), "importerCommit"],
  ] as const) {
    const value = await readFile(file, "utf8").then(
      (text) => {
        const record: unknown = JSON.parse(text);
        return isRecord(record) && typeof record[field] === "string" ? record[field] : null;
      },
      () => null,
    );
    if (value !== null) return value;
  }
  return null;
}

/** The regular, non-hidden files below `folder`, by `/`-separated relative path. */
async function packageFiles(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) =>
      path.relative(folder, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"),
    )
    .filter((file) => {
      const extension = path.extname(file).toLowerCase();
      return (
        file.endsWith(".tease") ||
        IMAGE_EXTENSIONS.has(extension) ||
        MEDIA_EXTENSIONS.has(extension)
      );
    });
}
