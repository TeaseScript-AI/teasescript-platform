// #1249; Astra review.
export const cases = (() => {
  const sources = {
    literal:
      'let a = {n: 1}\nlet b = {n: "x"}\nlet xs = [a, b]\nlet n: integer = hostValue\nexit\n',
    place:
      'let good = {n:1}\nlet bad = {n:"x"}\nlet copy = good\ncopy = bad\nsay copy.n\nlet n: integer = hostValue\nexit\n',
    relay:
      'let good = {n: 1}\nlet bad = {n: "x"}\nlet a = {inner: {inner: bad}}\nlet b = {inner: {inner: good}}\nlet c = b\nc = a\nsay "AFTER"\nb = c\na = b\nexit\n',
    ring: 'let good = {p0: 1, p1: 1}\nlet bad = {p0: "x", p1: "x"}\nlet a0 = good\nlet a1 = a0\nlet a2 = a1\na0 = a2\na2 = bad\nexit\n',
    writtenLiteral:
      'let w: integer = 1\nlet a = {n: w}\nlet b = {n: "x"}\nlet xs = [a, b]\nsay xs[0].n\nlet n: integer = hostValue\nexit\n',
    writtenPlace:
      'let s: string = "x"\nlet a = {n: 1}\nlet b = {n: s}\nlet copy = a\ncopy = b\nsay copy.n\nlet n: integer = hostValue\nexit\n',
    writtenProjection:
      'let w: integer = 1\nlet a = {n: w}\nlet b = {n: "x"}\nlet x = {inner: a}\nlet y = {inner: b}\nlet xs = [x.inner, y.inner]\nsay xs[0].n\nlet n: integer = hostValue\nexit\n',
    writtenRing:
      'let w: integer = 1\nlet a = {n: w}\nlet b = {n: "x"}\nlet c = a\nlet d = c\nc = d\nd = b\nsay c.n\nlet n: integer = hostValue\nexit\n',
    read: 'let a = {inner: {n: 1}}\na = a.inner\nlet bad = {n: "x"}\nlet copy = a\ncopy = bad\nsay copy.n\nlet n: integer = hostValue\nexit\n',
  };
  return Object.entries(sources);
})();
export const checks = ["publication", "stops"];
