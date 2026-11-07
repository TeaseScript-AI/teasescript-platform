// Independent references for the #1797 workloads (F-work): what each case must say, computed in plain JavaScript from
// the fixture's parameters and its tape, never by the runtime. `tools/benchmark-runtime.test.mjs` checks every
// manifest text against them. TeaseScript text positions and lengths count code points, as `[...text]` does here.
import crypto from "node:crypto";

const codePoints = (text) => [...text];
const count = (text, part) => text.split(part).length - 1;
/** The code-point position of the last `part` in `text`, or `null`. */
function lastIndexOf(text, part) {
  const at = text.lastIndexOf(part);
  return at < 0 ? null : codePoints(text.slice(0, at)).length;
}

/** `text-tail-*`: the text grown by `chunks` chunks of 64 code points, read, rewritten and said whole. */
export function textTail(chunks) {
  let text = "";
  let checks = 0;
  for (let i = 0; i < chunks; i++) {
    text += `${i % 10}abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ01234567\u{1F600}e\u0301`;
    if (i % 64 === 63) {
      const tail = codePoints(text).slice(-64);
      checks += tail.indexOf("\u{1F600}");
      checks += lastIndexOf(text, "e\u0301");
      checks += count(text, "Z0");
    }
    if (i % 256 === 100) text = text.replaceAll("Z0", "z0");
  }
  const length = codePoints(text).length;
  return [
    `text:${length}:${count(text, "\u{1F600}")}:${count(text, "e\u0301")}:${count(text, "Z0")}:${checks}`,
    text,
  ];
}

/** `collection-tail-10000`: the list, its changed and sorted copy, `targets` binary searches and the rotation. */
export function collectionTail(size, targets = 200) {
  const items = Array.from({ length: size }, (_, i) => (i * 7919) % 10007);
  const copy = [...items];
  for (let k = 0; k < size; k += 10) copy[k] += 1;
  copy.sort((a, b) => a - b);
  let found = 0;
  let probes = 0;
  for (let target = 0; target < targets; target++) {
    const wanted = target * 50;
    let lo = 0;
    let hi = copy.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      probes++;
      if (copy[mid] < wanted) lo = mid + 1;
      else hi = mid;
    }
    if (lo < copy.length && copy[lo] === wanted) found++;
  }
  for (let r = 0; r < 100; r++) copy.push(copy.shift() + 10007);
  const sum = (list) => list.reduce((total, value) => total + value, 0);
  return [
    `items:${items.length}:${sum(items)}:${items[0]}:${items.at(-1)}:${copy.length}:${sum(copy)}:` +
      `${copy[0]}:${copy.at(-1)}:${found}:${probes}`,
  ];
}

/** `transfer-project`: the hub's visits, rooms and popup calls, with every entered file in the trail. */
export function transferProject(lastVisit) {
  let entered = 0;
  let visits = 0;
  let trail = "";
  const enter = (place) => {
    entered++;
    trail += place;
  };
  enter("m");
  for (;;) {
    enter("h");
    visits++;
    if (visits > lastVisit) return [`transfer:${entered}:${visits}:${trail}`];
    if (visits % 3 === 0) {
      enter("p");
      visits++;
      trail += `${entered}`;
    }
    enter(`${visits % 2}`);
  }
}

const answers = (tape) => tape.map((entry) => entry.args[0].payload);

/**
 * `helper-input`: each ask says its question; the host refuses a number field's text that is no whole number, so the
 * same ask stays open; the script refuses numbers outside 1–10 and names over 12 code points and asks again. The
 * accepted answers are the tape's units.
 */
export function helperInput(tape) {
  const questions = { number: "How many rounds?", choice: "Which mode?", text: "Your name?" };
  const said = [];
  let accepted = 0;
  let refused = 0;
  let total = 0;
  let mode = null;
  let name = null;
  let open = false;
  for (const { interactionKind, payload } of tape.map((entry) => entry.args[0])) {
    if (!open) said.push(questions[interactionKind]);
    open = false;
    if (interactionKind === "choice") {
      mode = ["easy", "hard"][payload.optionIndex];
      accepted++;
    } else if (interactionKind === "text") {
      if (codePoints(payload.submittedText).length <= 12) {
        accepted++;
        name = payload.submittedText;
      } else {
        refused++;
        said.push("Shorter, please.");
      }
    } else if (!/^-?\d+$/.test(payload.submittedText)) open = true;
    else if (Number(payload.submittedText) >= 1 && Number(payload.submittedText) <= 10) {
      accepted++;
      total += Number(payload.submittedText);
    } else {
      refused++;
      said.push("Between 1 and 10, please.");
    }
  }
  const tapeUnits = tape.filter((entry) => entry.unit).length;
  if (accepted !== tapeUnits)
    throw new Error(`helper-input: ${accepted} accepted, the tape marks ${tapeUnits}`);
  return [...said, `helper:${accepted}:${refused}:${total}:${mode}:${name}`];
}

/** `storage-*`: rounds of saves from a stored total of 100; a failed write keeps the value stored before it. */
export function storage(tape) {
  const stored = new Map([["total", 100]]);
  const writes = [];
  let total = 100;
  for (let i = 1; i <= 4; i++) {
    writes.push([`round.${i}`, i * 3]);
    total += i * 3;
    writes.push(["total", total]);
  }
  writes.push(["round.1", null]);
  const outcomes = answers(tape).map((payload) => payload.kind);
  if (outcomes.length !== writes.length) throw new Error("storage: one acknowledgement per write");
  writes.forEach(([key, value], index) => {
    if (outcomes[index] !== "stored") return;
    if (value === null) stored.delete(key);
    else stored.set(key, value);
  });
  let back = 0;
  for (let k = 1; k <= 4; k++) back += stored.get(`round.${k}`) ?? -100;
  return [`storage:${total}:${back}:${stored.get("total") ?? -1}`];
}

/** `file-store`: the first file's Base64 and SHA-256, the length of `toJson`'s text with both data URLs, two files. */
export function fileStore(tape) {
  const first = Buffer.from("Hello, file!");
  const second = Buffer.from("Second file");
  const hash = crypto.createHash("sha256").update(first).digest("hex");
  const hashed = answers(tape).find((payload) => payload.kind === "hashed");
  if (hashed?.hashes[0] !== hash)
    throw new Error("file-store: the fake store must give the real SHA-256");
  const url = (bytes) => `data:application/octet-stream;base64,${bytes.toString("base64")}`;
  const json = JSON.stringify({ files: [url(first), url(second)] });
  return [`files:${first.toString("base64")}:${hash}:${codePoints(json).length}:2`];
}

/** `form-completion`: each form's question, then its answers after its tape's edits, in field order. */
export function formCompletion(tape) {
  const forms = [];
  let values = { sound: false, level: 0, rounds: 5, note: null };
  let editor = null;
  const levels = ["Low", "Mid", "High"];
  const commit = () => {
    if (editor === null) return true;
    if (editor.fieldId === "rounds") {
      if (!/^\d+$/.test(editor.text) || Number(editor.text) < 1 || Number(editor.text) > 20)
        return false;
      values.rounds = Number(editor.text);
    } else values.note = editor.text === "" ? null : editor.text;
    editor = null;
    return true;
  };
  for (const entry of tape) {
    const request = entry.args[0];
    if (entry.kind === "completeAction") {
      commit();
      forms.push(values);
      values = { sound: false, level: 0, rounds: 5, note: null };
      continue;
    }
    const update = request.update;
    if (update.kind === "select") {
      if (!commit()) continue;
      values[update.fieldId] =
        update.fieldId === "sound" ? update.optionIndex === 1 : update.optionIndex;
    } else if (update.kind === "edit") {
      if (!commit()) continue;
      editor = { fieldId: update.fieldId, text: String(values[update.fieldId] ?? "") };
    } else if (update.kind === "draft") editor.text = update.text;
    else if (update.kind === "commit") commit();
  }
  const shown = forms.map(
    (form) => `${form.sound}/${levels[form.level]}/${form.rounds}/${form.note ?? "-"}`,
  );
  return [...forms.map(() => "Settings?"), `forms:${forms.length}:${shown.join("|")}`];
}
