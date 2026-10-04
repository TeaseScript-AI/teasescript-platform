import assert from "node:assert/strict";
import test from "node:test";
import { watchProjectDiagnostics, type ProjectFileView } from "../src/editor/model-diagnostics.js";

class FakeModel {
  #listener: (() => void) | null = null;

  public constructor(public text: string) {}

  public getValue(): string {
    return this.text;
  }
  public onDidChangeContent(listener: () => void): { dispose(): void } {
    this.#listener = listener;
    return {
      dispose: () => {
        this.#listener = null;
      },
    };
  }
  public emitChange(): void {
    this.#listener?.();
  }
}

test("each project file gets its own markers and header, and edits replace stale ones", () => {
  const main = new FakeModel('---\ntitle: "Evening"\n---\nexit');
  const hall = new FakeModel("let answer = askText as\nexit");
  const publications: (readonly ProjectFileView[])[] = [];
  const subscription = watchProjectDiagnostics(
    [
      { path: "rooms/hall.tease", model: hall },
      { path: "main.tease", model: main },
    ],
    { Error: 8, Warning: 4 },
    (files) => publications.push(files),
  );
  const [first] = publications;
  assert.deepEqual(
    first!.map((file) => [file.path, file.header?.title ?? null, file.markers.length > 0]),
    [
      ["main.tease", "Evening", false],
      ["rooms/hall.tease", null, true],
    ],
  );

  hall.text = '---\ntags: "room", intensity: 2\n---\nlet answer = askText\nexit';
  hall.emitChange();
  assert.deepEqual(publications[1]![1], {
    path: "rooms/hall.tease",
    header: publications[1]![1]!.header,
    markers: [],
  });
  assert.deepEqual(publications[1]![1]!.header!.tags, [
    { name: "room", value: null },
    { name: "intensity", value: 2 },
  ]);

  subscription.dispose();
  main.emitChange();
  hall.emitChange();
  assert.equal(publications.length, 2);
});
