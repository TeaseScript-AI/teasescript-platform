import assert from "node:assert/strict";
import test from "node:test";
import { watchModelDiagnostics } from "../src/editor/model-diagnostics.js";
import type { MonacoMarker } from "../src/editor/monaco-mapping.js";

class FakeModel {
  public readonly uri = { toString: () => "file:///main.tease" };
  public text = "let answer = askText as";
  #listener: (() => void) | null = null;

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

test("model changes replace stale canonical diagnostics", () => {
  const model = new FakeModel();
  const publications: (readonly MonacoMarker[])[] = [];
  const subscription = watchModelDiagnostics(model, { Error: 8, Warning: 4 }, (markers) =>
    publications.push(markers),
  );
  assert.ok(publications[0]!.length > 0);
  model.text = "let answer = askText";
  model.emitChange();
  assert.deepEqual(publications[1], []);
  subscription.dispose();
});
