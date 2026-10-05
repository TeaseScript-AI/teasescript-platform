import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadRepositoryCatalogTools,
  readCatalogEntries,
  renderCatalogPage,
  writeSourceViews,
  type CatalogTools,
} from "../tools/catalog.ts";

const toolsResult = await loadRepositoryCatalogTools().then(
  (tools): { tools: CatalogTools } | { reason: string } => ({ tools }),
  (error: unknown) => ({ reason: error instanceof Error ? error.message : String(error) }),
);

test(
  "the catalog lists every package with its header, Player link, status, and source files",
  { skip: "reason" in toolsResult ? toolsResult.reason : false },
  async () => {
    const work = await mkdtemp(path.join(tmpdir(), "sexscript-catalog-"));
    try {
      const write = async (file: string, content: string | Record<string, unknown>) => {
        await mkdir(path.dirname(path.join(work, file)), { recursive: true });
        await writeFile(
          path.join(work, file),
          typeof content === "string" ? content : JSON.stringify(content),
        );
      };
      const run = (status: string) => ({
        smokeRuns: [
          {
            entry: "main.tease",
            isolated: false,
            status,
            failure: null,
            blockedTarget: null,
            steps: 3,
          },
        ],
      });
      await write("corpus/Night Walk/scripts/walk.groovy", 'show("Hello")\n');
      await write("converted/Night Walk/.conversion.json", {
        source: path.join(work, "corpus/Night Walk"),
      });
      await write("converted/Night Walk/.report.json", run("halted"));
      await write(
        "converted/Night Walk/main.tease",
        '---\ntitle: "Night <Walk> & Talk"\nauthor: "Ann"\ndescription: "A short walk."\nkeywords: "walk", "night"\n---\nsay "Hello"\nexit\n',
      );
      await write("converted/broken/.report.json", {
        fileCount: 2,
        migrationCleanFileCount: 1,
        projectCompiles: false,
        ...run("blocked"),
      });
      await write(
        "converted/broken/main.tease",
        '---\ntitle: "Broken"\n---\n// TODO CODE line 3: unsupported call\nsay missingName\nexit\n',
      );
      // Only commands that are not built yet keep this one from compiling.
      await write("converted/popup/.report.json", {
        projectCompiles: true,
        pendingCapabilityFileCounts: { showPopup: 1 },
        ...run("halted"),
      });
      await write("converted/popup/main.tease", '---\ntitle: "Popup"\n---\nshowPopup "Hi"\nexit\n');
      await write("converted/menu/rooms/hall.tease", "say 1\nexit\n");
      await write("converted/.hidden/main.tease", 'say "not a package"\nexit\n');

      // EVIDENCE: the test is skipped unless the tools loaded, so toolsResult holds them here.
      const tools = (toolsResult as { tools: CatalogTools }).tools;
      const entries = await readCatalogEntries(path.join(work, "converted"), tools);
      assert.deepEqual(
        entries.map(({ id, status, partial }) => [id, status.label, partial?.label ?? null]),
        [
          ["broken", "does not compile", "partly converted (1/2, 1 TODO)"],
          ["menu", "no main.tease", null],
          ["Night Walk", "runs to the end", null],
          ["popup", "needs showPopup", null],
        ],
      );
      assert.match(entries[0]!.status.detail, /^main\.tease:5:5 TSV002 /u);

      const page = renderCatalogPage(entries, {
        playerOrigin: "https://example.test:4443",
        measurement: { importerCommit: "abc1234", measuredAt: "2026-10-05T01:00:00.000Z" },
      });
      assert.match(
        page,
        /<a href="https:\/\/example\.test:4443\/player\/\?package=Night%20Walk"><b>Night &lt;Walk&gt; &amp; Talk<\/b><\/a><\/td><td class="author">Ann<\/td><td class="keywords">walk, night<\/td>/u,
      );
      assert.match(
        page,
        /<a href="source\/Night%20Walk\/groovy\/walk\.groovy">Groovy<\/a> &middot; <a href="source\/Night%20Walk\/tease\/main\.tease">TeaseScript<\/a>/u,
      );
      // Listed, convert fully, compile, run to the end, stop during the run, need unbuilt commands, do not compile.
      assert.match(
        page,
        /<tr><td>4<\/td><td>3<\/td><td>1<\/td><td>1<\/td><td>0<\/td><td>1<\/td><td>2<\/td><\/tr>/u,
      );
      assert.match(page, /Measured 2026-10-05 with importer commit abc1234/u);
      assert.equal(page.match(/<button type="button" data-pin=/gu)?.length, 4);

      await writeSourceViews(entries, path.join(work, "catalog"));
      assert.equal(
        await readFile(path.join(work, "catalog/source/Night Walk/groovy/walk.groovy"), "utf8"),
        'show("Hello")\n',
      );
      assert.match(
        await readFile(path.join(work, "catalog/source/Night Walk/tease/main.tease"), "utf8"),
        /say "Hello"/u,
      );
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
);
