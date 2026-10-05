import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  approvedPackages,
  loadRepositoryCatalogTools,
  packageContentHash,
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
      const played = (source: string, verdict: string) => ({
        contentHash: packageContentHash([{ path: "main.tease", source }]),
        verdict,
        checkedAt: "2026-10-05T03:00:00.000Z",
        runs: [{ stop: { kind: "ended", detail: "the session reached its end" } }],
        coverage: { files: ["main.tease"], fileCount: 1, sites: 2, siteCount: 2, choices: 3 },
        missingImages: [],
        missingMedia: [],
      });
      const walk =
        '---\ntitle: "Night <Walk> & Talk"\nauthor: "Ann"\ndescription: "A short walk."\nkeywords: "walk", "night"\n---\nsay "Hello"\nexit\n';
      await write("corpus/Night Walk/scripts/walk.groovy", 'show("Hello")\n');
      // An earlier version stays in the legacy folder; it is listed with its version, not as the package's source.
      await write("corpus/Night Walk/scripts/walk__old.groovy", 'show("Hi")\n');
      await write("corpus/Night Walk/unit.json", {
        unit: "Night Walk",
        earlierVersions: [
          {
            title: "Night Walk 1.0",
            status: "finished",
            date: "2013-05-01",
            files: ["scripts/walk__old.groovy"],
          },
        ],
      });
      await write("converted/Night Walk/.conversion.json", {
        source: path.join(work, "corpus/Night Walk"),
      });
      await write("converted/Night Walk/main.tease", walk);
      await write("checks/Night Walk/result.json", played(walk, "plays"));
      await write("converted/broken/.report.json", { fileCount: 2, migrationCleanFileCount: 1 });
      await write(
        "converted/broken/main.tease",
        '---\ntitle: "Broken"\n---\n// TODO CODE line 3: unsupported call\nsay missingName\nexit\n',
      );
      // A check of other contents than the current files is stale.
      await write("checks/broken/result.json", played("say 1\nexit\n", "plays"));
      await write("converted/popup/main.tease", '---\ntitle: "Popup"\n---\nshowPopup "Hi"\nexit\n');
      await write("converted/menu/rooms/hall.tease", "say 1\nexit\n");
      await write("converted/.hidden/main.tease", 'say "not a package"\nexit\n');
      await write("verified/garden/main.tease", '---\ntitle: "Garden"\n---\nsay "Green"\nexit\n');
      // A session that halts at Start without showing anything does not start, although it compiles.
      const quiet = '---\ntitle: "Quiet"\n---\nexit\n';
      await write("converted/quiet/main.tease", quiet);
      await write("checks/quiet/result.json", {
        ...played(quiet, "stops"),
        runs: [{ stop: { kind: "empty", detail: "the session ended without showing anything" } }],
      });
      await write("converted/stub/.conversion.json", {
        unitStatus: "unfinished-content-stub",
        converter: "def5678",
      });
      await write("converted/stub/main.tease", '---\ntitle: "Stub"\n---\nsay "Soon"\nexit\n');
      await write("verified/garden/.verified.json", {
        date: "2026-10-05",
        importerCommit: "abc1234",
      });

      // EVIDENCE: the test is skipped unless the tools loaded, so toolsResult holds them here.
      const tools = (toolsResult as { tools: CatalogTools }).tools;
      const entries = await readCatalogEntries(path.join(work, "converted"), tools, {
        playChecks: [path.join(work, "checks")],
        verified: path.join(work, "verified"),
        approved: approvedPackages("| Package | Date |\n| --- | --- |\n| `popup` | 2026-10-05 |\n"),
      });
      assert.deepEqual(
        entries.map(({ id, status, partial }) => [id, status.label, partial?.label ?? null]),
        [
          ["broken", "does not compile", "partly converted (1/2, 1 TODO)"],
          ["garden", "verified", null],
          ["menu", "no main.tease", null],
          ["Night Walk", "plays to the end", null],
          ["popup", "owner-approved", null],
          ["quiet", "shows nothing", null],
          ["stub", "unfinished stub", null],
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
      assert.ok(
        page.includes(
          '<details class="earlier"><summary>Earlier versions (1)</summary><ul><li>Night Walk 1.0 &middot; finished &middot; 2013-05-01<br>Groovy: <a href="source/Night%20Walk/earlier/1/scripts/walk__old.groovy">scripts/walk__old.groovy</a></li></ul></details>',
        ),
      );
      assert.ok(
        page.includes(
          '<dl class="summary"><div><dt>Listed</dt><dd>7</dd></div><div><dt>Convert fully</dt><dd>6</dd></div><div><dt>Compile</dt><dd>4</dd></div><div><dt>Play to the end</dt><dd>3</dd></div><div><dt>Stop during play</dt><dd>0</dd></div><div><dt>Do not start</dt><dd>1</dd></div><div><dt>Do not compile</dt><dd>2</dd></div><div><dt>Not played yet</dt><dd>0</dd></div><div><dt>Blocked by unbuilt commands</dt><dd>0</dd></div><div><dt>Verified</dt><dd>1</dd></div><div><dt>Owner-approved</dt><dd>1</dd></div><div><dt>Unfinished stubs</dt><dd>1</dd></div></dl>',
        ),
      );
      assert.match(
        page,
        /Measured 2026-10-05 with importer commits abc1234 \(6 units\), def5678 \(1 units\)/u,
      );
      // A stub is listed without a Player link.
      assert.match(page, /<td class="title"><b>Stub<\/b><\/td>/u);
      assert.equal(page.match(/<button type="button" data-pin=/gu)?.length, 7);

      await writeSourceViews(entries, path.join(work, "catalog"));
      assert.equal(
        await readFile(path.join(work, "catalog/source/Night Walk/groovy/walk.groovy"), "utf8"),
        'show("Hello")\n',
      );
      assert.equal(
        await readFile(
          path.join(work, "catalog/source/Night Walk/earlier/1/scripts/walk__old.groovy"),
          "utf8",
        ),
        'show("Hi")\n',
      );
      assert.match(
        await readFile(path.join(work, "catalog/source/garden/tease/main.tease"), "utf8"),
        /say "Green"/u,
      );
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
);
