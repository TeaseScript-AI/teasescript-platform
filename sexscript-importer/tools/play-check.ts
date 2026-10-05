/// <reference lib="dom" />
/**
 * Plays converted packages in the real Player through its UI, on several paths per package, and records how far each
 * run got and why it stopped.
 *
 * Usage: node tools/play-check.ts [--base <origin>] [--runs N] [--steps N] [--only id,id] [--again] <converted-root>
 *   <out-dir>
 *
 * Each package opens at `<origin>/player/?package=<id>` (default `https://agents.home.arpa:4443`, see
 * `serve-catalog.ts`) in headless Chromium, one browser at a time. A run presses buttons, picks choices, and types
 * answers until the session halts, fails, hangs, or the step budget ends. Playwright's fake clock skips waits, timers,
 * and chat pacing, and media play at 16 times speed. A prompt that comes back three times in a row may wait for an
 * answer that takes time, so the runner then lets 30 seconds pass before answering, and 120 seconds the next time,
 * noted in the run's path as `[waited 30 s]`; this stands in for development time controls (#615). Each run picks, at
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
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";
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
/** A run that takes longer in real time ends as `budget`: a very long session, or one that stopped responding. */
const RUN_TIMEOUT_MS = 240_000;
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
  readonly verdict: "plays" | "stops" | "no-start";
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
  const outFolder = path.join(out, id);
  if (!values.again) {
    const last = await readFile(path.join(outFolder, "result.json"), "utf8").then(
      (text) => parsePlayCheck(JSON.parse(text)),
      () => null,
    );
    if (last?.contentHash === packageContentHash(sources)) return null;
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
    try {
      const page = await context.newPage();
      const timedOut = new Promise<RunResult>((resolve) => {
        timer = setTimeout(() => {
          const screenshot = `run-${run + 1}.png`;
          void page
            .screenshot({ path: path.join(outFolder, screenshot), timeout: 5_000 })
            .then(
              () => screenshot,
              () => null,
            )
            .then((taken) =>
              resolve({
                run,
                stop: {
                  kind: "budget",
                  detail: `still running after ${RUN_TIMEOUT_MS / 60_000} minutes of real time`,
                  file: null,
                  line: null,
                  code: null,
                },
                steps: 0,
                files: [],
                path: [],
                lastText: "",
                screenshot: taken,
              }),
            );
        }, RUN_TIMEOUT_MS);
      });
      const playing = playOnce(page, id, run, outFolder, {
        tries,
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
      result = {
        run,
        stop: {
          kind: "harness",
          detail: error instanceof Error ? error.message.split("\n")[0]! : String(error),
          file: null,
          line: null,
          code: null,
        },
        steps: 0,
        files: [],
        path: [],
        lastText: "",
        screenshot: null,
      };
    } finally {
      clearTimeout(timer);
      // A context the browser already dropped cannot be closed again; that must not end the batch.
      await context.close().catch(() => undefined);
    }
    runs.push(result);
    if (Date.now() - started > PACKAGE_TIMEOUT_MS) break;
    if (["no-start", "empty", "hang", "budget", "harness"].includes(result.stop.kind)) break;
    if (run > 0 && coveredFiles.size + coveredSites.size + coveredChoices.size === before) break;
  }
  fileCount = Math.max(fileCount, coveredFiles.size);
  const notEnded = runs.find((item) => item.stop.kind !== "ended");
  const verdict =
    runs[0]?.stop.kind === "no-start" ? "no-start" : notEnded === undefined ? "plays" : "stops";
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
    seen(state: PlayerState): void;
    chose(site: string, option: number): void;
  },
): Promise<RunResult> {
  const files = new Set<string>();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    // Media play at 16 times speed, so a script that waits for a sound does not wait in real time.
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      this.playbackRate = 16;
      return play.call(this);
    };
  });
  await page.clock.install();
  await page.goto(`${values.base}/player/?package=${encodeURIComponent(id)}`);
  await page.waitForSelector("[data-session-activation] button, [data-script-failure]", {
    timeout: 30_000,
  });
  let state = await readState(page);
  const taken: string[] = [];
  const finish = async (
    kind: RunResult["stop"]["kind"],
    detail: string,
    steps: number,
    where: { file: string | null; line: number | null; code: string | null } = {
      file: null,
      line: null,
      code: null,
    },
  ) => {
    const screenshot = `run-${run + 1}.png`;
    await page.screenshot({ path: path.join(outFolder, screenshot) });
    return {
      run,
      stop: { kind, detail, ...where },
      steps,
      files: [...files].sort(),
      path: taken,
      lastText: state.lastText,
      screenshot,
    };
  };
  if (state.scriptFailure !== null) return finish("no-start", state.scriptFailure, 0);
  await page.click("[data-session-activation] button");
  const visits = new Map<string, number>();
  // The prompt answered last, how often in a row, and how many waits that streak has had.
  let repeated = { key: "", count: 0, waits: 0 };
  let unchanged = 0;
  let lastProgress = -1;
  let progressAt = Date.now();
  for (let step = 0; step < Number(values.steps);) {
    state = await readState(page);
    track.seen(state);
    if (state.file !== null) files.add(state.file);
    if (state.status === "halted") {
      if (step === 0 && state.entries === 0 && state.stageImage === null)
        return finish("empty", "the session ended without showing anything", step);
      // For example a script that needs legacy settings, such as owned toys, that a fresh player does not have.
      if (step === 0 && state.sites > 0)
        return finish("early-end", `ended before its first interaction: "${state.lastText}"`, step);
      return finish("ended", "the session reached its end", step);
    }
    if (state.status === "failed" || state.failure !== null) {
      const failure = state.failure;
      return finish(
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
    if (pageErrors.length > 0) return finish("error", `page error: ${pageErrors[0]}`, step);
    if (state.progress === lastProgress) unchanged += 1;
    else {
      unchanged = 0;
      progressAt = Date.now();
    }
    lastProgress = state.progress;
    // About 20 minutes of skipped time and half a minute of real time, for media, without any new event.
    if (unchanged > 60 && Date.now() - progressAt > 30_000)
      return finish(
        "hang",
        `nothing happens while waiting for ${state.foreground ?? "nothing"}`,
        step,
        {
          file: state.site?.slice(0, state.site.lastIndexOf(":")) ?? state.file,
          line:
            state.site === null ? null : Number(state.site.slice(state.site.lastIndexOf(":") + 1)),
          code: null,
        },
      );
    if (state.foreground?.startsWith("interaction:") === true && state.site !== null) {
      const kind = state.foreground.slice("interaction:".length);
      const visit = visits.get(state.site) ?? 0;
      visits.set(state.site, visit + 1);
      // A script may time how long its prompt stays unanswered, as in "beg for at least 15 seconds". The same place
      // with the same options and text counts as the same prompt; a loop over questions, such as toys, does not.
      const key = `${state.site}\u0000${state.options.join("\u0000")}\u0000${state.lastText}`;
      repeated =
        key === repeated.key
          ? { ...repeated, count: repeated.count + 1 }
          : { key, count: 1, waits: 0 };
      if (
        repeated.count >= 3 &&
        repeated.waits < 2 &&
        (state.options.length > 0 || state.composer !== null)
      ) {
        const seconds = repeated.waits === 0 ? 30 : 120;
        await page.clock.fastForward(seconds * 1_000);
        taken.push(`[waited ${seconds} s]`);
        repeated = { key, count: 0, waits: repeated.waits + 1 };
      }
      if ((kind === "button" || kind === "choice") && state.options.length > 0) {
        const counts =
          track.tries.get(state.site) ?? new Array<number>(state.options.length).fill(0);
        track.tries.set(state.site, counts);
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
        counts[option] = (counts[option] ?? 0) + 1;
        track.chose(state.site, option);
        taken.push(`${state.site} → ${state.options[option] ?? option}`);
        await page.click(`[data-foreground-controls] button >> nth=${option}`, { timeout: 5_000 });
        step += 1;
      } else if (state.composer !== null) {
        const answers =
          state.composer.mode === "numeric" || state.composer.mode === "decimal"
            ? NUMBER_ANSWERS
            : TEXT_ANSWERS;
        // A prompt that quotes a sentence, as in a lines game ("Write 'I will obey' ten times"), gets that sentence.
        // Or one that names it after "Type:" or "Write:" at the end of a line.
        const quoted =
          answers === TEXT_ANSWERS
            ? ([...state.recentText.matchAll(/["'“„«]([^"'“”„«»\n]{3,200})["'”“»]/gu)].at(
                -1,
              )?.[1] ??
              [
                ...state.recentText.matchAll(
                  /(?:^|\n)\s*(?:type|write|copy|schreibe|tippe)\s*:\s*([^\n]{3,200}?)\s*$/gimu,
                ),
              ].at(-1)?.[1])
            : undefined;
        const answer =
          ISO_ANSWERS[state.composer.type] ?? quoted ?? answers[(run + visit) % answers.length]!;
        taken.push(`${state.site} → "${answer}"`);
        await page.fill("[data-composer-input]", answer, { timeout: 5_000 });
        await page.press("[data-composer-input]", "Enter", { timeout: 5_000 });
        step += 1;
      } else if (kind !== "button" && kind !== "choice" && unchanged > 3) {
        return finish("unsupported", `no control for the ${kind} interaction`, step);
      }
      await page.clock.fastForward(300);
    } else if (state.foreground === "delay" && state.delayMs !== null) {
      // Jumping fires each due timer once, instead of every animation frame on the way.
      await page.clock.fastForward(Math.max(50, state.delayMs + 50));
    } else {
      // Media play in real time; everything else waits on the fake clock.
      if (state.foreground === "media") await new Promise((resolve) => setTimeout(resolve, 250));
      if (unchanged > 2) await page.clock.fastForward(20_000);
      else await page.clock.fastForward(1_000);
    }
  }
  return finish(
    "budget",
    `${values.steps} interactions without reaching the end`,
    Number(values.steps),
  );
}

/** Reads the session from the Player's mounted Vue tree and the controls from the page. */
function readState(page: Page): Promise<PlayerState> {
  return page.evaluate(() => {
    type Session = {
      plan: {
        files: Array<{ path: string; startInstruction: number; endInstruction: number }>;
        instructions: Array<{ kind: string; span?: { sl: number } }>;
      };
      snapshot: {
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
        nextEventSequence: number;
        frames: Array<{ file: number }> | { file: number };
        stageImage: unknown;
        settledMedia: Array<{ source: string; loaded: boolean }>;
        backgroundActions: Array<{ media?: { source: string; loaded: boolean } }>;
      };
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
    const snapshot = session?.snapshot;
    const fileOf = (instruction: number | undefined) =>
      instruction === undefined
        ? null
        : (session?.plan.files.find(
            (file) => instruction >= file.startInstruction && instruction <= file.endInstruction,
          )?.path ?? null);
    const action = snapshot?.foregroundAction ?? null;
    const site =
      action?.kind !== "interaction" || action.owningInstruction === undefined
        ? null
        : `${fileOf(action.owningInstruction)}:${(session?.plan.instructions[action.owningInstruction]?.span?.sl ?? -1) + 1}`;
    const composer = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(
      "[data-composer-input]",
    );
    const stage = document.querySelector<HTMLImageElement>(".stage-media");
    const stageImage = typeof snapshot?.stageImage === "string" ? snapshot.stageImage : null;
    const media = [
      ...(snapshot?.settledMedia ?? []),
      ...(snapshot?.backgroundActions ?? []).flatMap((item) =>
        item.media === undefined ? [] : [item.media],
      ),
    ].map((item) => ({ source: item.source, loaded: item.loaded }));
    const frames = snapshot?.frames;
    const frame = Array.isArray(frames) ? frames.at(-1) : frames;
    const frameFile = frame === undefined ? null : (session?.plan.files[frame.file]?.path ?? null);
    return {
      status: snapshot?.status ?? null,
      failure:
        snapshot?.failure == null
          ? null
          : {
              code: snapshot.failure.code,
              message: snapshot.failure.message,
              path: snapshot.failure.path ?? null,
              line:
                snapshot.failure.span?.start === undefined
                  ? null
                  : snapshot.failure.span.start.line + 1,
            },
      foreground:
        action === null
          ? null
          : action.kind === "interaction"
            ? `interaction:${action.interactionKind}`
            : action.kind,
      site,
      delayMs:
        action?.kind === "delay" && action.deadlineMs !== undefined && snapshot !== undefined
          ? action.deadlineMs - snapshot.currentSessionTimeMs
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
        (snapshot?.nextEventSequence ?? 0) * 1000 + (session?.transcriptEntries.length ?? 0),
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
