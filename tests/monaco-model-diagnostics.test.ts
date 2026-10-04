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

  // Every model is watched, not only the first.
  main.text = '---\ntitle: "Late evening"\n---\nexit';
  main.emitChange();
  assert.deepEqual(
    publications[2]!.map((file) => [file.path, file.header?.title ?? null]),
    [
      ["main.tease", "Late evening"],
      ["rooms/hall.tease", null],
    ],
  );

  subscription.dispose();
  main.emitChange();
  hall.emitChange();
  assert.equal(publications.length, 3);
});

test("a project diagnostic without its own file still gets a row", () => {
  let files: readonly ProjectFileView[] = [];
  watchProjectDiagnostics(
    [{ path: "rooms/hall.tease", model: new FakeModel("exit") }],
    { Error: 8, Warning: 4 },
    (published) => (files = published),
  ).dispose();
  assert.deepEqual(
    files.map((file) => [file.path, file.markers.map((marker) => marker.code)]),
    [
      ["main.tease", ["TSC009"]],
      ["rooms/hall.tease", []],
    ],
  );
});

test("tag queries search the package images the project is watched with", () => {
  const models = [{ path: "main.tease", model: new FakeModel('showImage tagged "garden"\nexit') }];
  const codes = (images?: readonly { path: string; keywords: readonly string[] }[]) => {
    let files: readonly ProjectFileView[] = [];
    watchProjectDiagnostics(
      models,
      { Error: 8, Warning: 4 },
      (published) => (files = published),
      images === undefined ? {} : { images },
    ).dispose();
    return files.flatMap((file) => file.markers.map((marker) => marker.code));
  };
  assert.deepEqual(codes(), []);
  assert.deepEqual(codes([{ path: "hall.png", keywords: ["hall"] }]), ["TST002"]);
  assert.deepEqual(codes([{ path: "garden.png", keywords: ["garden"] }]), []);
});
