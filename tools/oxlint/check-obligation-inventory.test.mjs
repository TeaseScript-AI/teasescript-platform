import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { Project } from "ts-morph";

import { obligationInventoryDiagnostics, READS } from "./check-obligation-inventory.mjs";
import { repositoryRoot } from "./files.mjs";

const ADMISSION = "src/type-inference/core/admission.ts";
const CONSUMERS = "src/type-inference/core/consumers.ts";

/**
 * The check's messages for the repository's two files, each changed in memory by its `edit` (a scratch copy). The files
 * as they are pass the check in `npm run lint` (`run.mjs`); these are its negative checks (TABLE r4.143).
 */
function messagesWith(edits) {
  const project = new Project({
    tsConfigFilePath: resolve(repositoryRoot, "tsconfig.json"),
    skipAddingFilesFromTsConfig: true,
  });
  for (const file of [ADMISSION, CONSUMERS]) {
    const source = project.addSourceFileAtPath(resolve(repositoryRoot, file));
    const edit = edits[file];
    if (edit !== undefined) {
      const text = source.getFullText();
      const changed = edit(text);
      assert.notEqual(changed, text, `the scratch copy of ${file} changes`);
      source.replaceWithText(changed);
    }
  }
  project.resolveSourceFileDependencies();
  return obligationInventoryDiagnostics(project.getProgram().compilerObject, repositoryRoot, {
    admission: ADMISSION,
    consumers: CONSUMERS,
    reads: READS,
  }).map((diagnostic) => diagnostic.message);
}

test("a call from an obligation-creating consumer method into an unlisted Admission method fails, whatever its name", () => {
  const messages = messagesWith({
    [ADMISSION]: (text) =>
      text.replace(
        "  public valueAt(",
        "  public newDecision(): number {\n    return 0;\n  }\n\n  public valueAt(",
      ),
    [CONSUMERS]: (text) =>
      text.replace(
        "  #freshStores(): void {\n",
        "  #freshStores(): void {\n    this.admission.newDecision();\n",
      ),
  });
  assert.ok(
    messages.some((message) => message.includes("calls Admission.newDecision")),
    messages.join("\n"),
  );
});

test("a fresh-pass derivation left in a block comment, or an entry left out of the list, fails", () => {
  const commented = messagesWith({
    [CONSUMERS]: (text) =>
      text.replace(/\n( +)(this\.admission\.ingressStores\(\(site\)[^\n]*\);)/, "\n$1/* $2 */"),
  });
  assert.ok(
    commented.some((message) => message.includes("does not call ingressStores")),
    commented.join("\n"),
  );
  const unlisted = messagesWith({
    [ADMISSION]: (text) => text.replace('method: "decide",', 'method: "decided",'),
  });
  assert.ok(
    unlisted.some((message) => message.includes("calls Admission.decide:")),
    unlisted.join("\n"),
  );
});

test("an Admission method that creates an obligation itself must be listed", () => {
  const messages = messagesWith({
    [ADMISSION]: (text) =>
      text.replace(
        "  public valueAt(",
        '  public extraBoundary(site: SourceSite): void {\n    this.readChecks.push(boundaryCheck(site, "x", ["unknown"], "validate x"));\n  }\n\n  public valueAt(',
      ),
  });
  assert.ok(
    messages.some((message) => message.includes("Admission.extraBoundary creates an obligation")),
    messages.join("\n"),
  );
});

test("a call of a host member whose consumer implementation marks creates an obligation, in a new method or a read", () => {
  const call = '    this.host.undecidedIngress?.({ file: 0, start: 0, end: 0 }, "x");\n';
  const added = messagesWith({
    [ADMISSION]: (text) =>
      text.replace(
        "  public valueAt(",
        `  public openIngress(): void {\n${call}  }\n\n  public valueAt(`,
      ),
  });
  assert.ok(
    added.some((message) => message.includes("Admission.openIngress creates an obligation")),
    added.join("\n"),
  );
  const read = messagesWith({
    [ADMISSION]: (text) =>
      text.replace(
        "  public admitted(place: PlaceId, path: readonly string[]): ItemTag[] {\n",
        `  public admitted(place: PlaceId, path: readonly string[]): ItemTag[] {\n${call}`,
      ),
  });
  assert.ok(
    read.some((message) =>
      message.includes("Admission.admitted creates an obligation; it is no read"),
    ),
    read.join("\n"),
  );
});
