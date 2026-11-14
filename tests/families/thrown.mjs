// Where a run threw, as the evidence command compares it (#2796): the error's class and the function and file of the
// first frame of its stack, the file as its path below the tree's `dist/`, so that the same throw on two trees reads the
// same. Never the message, which can quote a source; never the line, which moves between trees; never how the function
// was called (`Module.`).

/** `<class> at <function> (<file>)` of an error or of its stack's text; `<class>` alone where no frame is read. */
export function throwPlace(thrown) {
  const text = String(thrown?.stack ?? thrown ?? "");
  const [first = "", ...rest] = text.split("\n");
  const name = thrown?.name ?? (/^([\w$.]+)(?::|$)/u.exec(first.trim())?.[1] || "thrown");
  const frame = rest
    .map((line) => /^\s*at (?:(.+?) \()?(.+?):\d+:\d+\)?$/u.exec(line))
    .find(Boolean);
  if (frame === undefined) return name;
  const [, called = "<anonymous>", file] = frame;
  // (V8 names a function called through a module namespace `Module.<name>`: the caller's way, not the place)
  const fn = called.replace(/^Module\./u, "");
  const below = /\/dist\/(.+)$/u.exec(file.replace(/^file:\/\//u, ""))?.[1];
  return `${name} at ${fn} (${below ?? file.split("/").at(-1)})`;
}
