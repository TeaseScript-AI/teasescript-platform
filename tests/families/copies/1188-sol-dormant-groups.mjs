// #1188; Sol review: size-dependent shapes source families.
export const sizes = [4, 8];
const corpus = (() => {
  const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const source = (...parts) => parts.flat(Infinity).join("\n") + "\nexit\n";
  const fields = (n, value) => rows(n, (i) => `f${i}:${value}`).join(",");
  const shapes = {
    "rejected-relay-literal": (n) =>
      source(
        "let typed:integer=17",
        `let shared={${fields(n, "typed")}}`,
        rows(n, (i) => [
          `let inner${i}=[{f${i}:false},shared]`,
          `let wrap${i}={value:inner${i}}`,
          `let relay${i}=wrap${i}`,
          `let final${i}=[relay${i}.value.first,shared]`,
        ]),
      ),
    "dormant-meetings-literal": (n) =>
      source(
        "let typed:integer=17",
        `let exact={${fields(n, "typed")}}`,
        `let fraction={${fields(n, "1.5")}}`,
        "let container=fraction",
        "container=exact",
        rows(n, (i) => [
          `let alias${i}=container`,
          `alias${i}.extra${i}=typed`,
          `let final${i}=[container,alias${i}]`,
        ]),
      ),
    "dormant-meetings-place": (n) =>
      source(
        "let typed:integer=17",
        `let exact={${fields(n, "typed")}}`,
        `let fraction={${fields(n, "1.5")}}`,
        "let container=fraction",
        "container=exact",
        rows(n, (i) => [
          `let alias${i}=container`,
          `alias${i}.extra${i}=typed`,
          `let final${i}=container`,
          `final${i}=alias${i}`,
        ]),
      ),
    "three-groups-self": (n) =>
      source(
        "let typed:integer=17",
        'let word:string="x"',
        "let flag:boolean=true",
        `let shared={${fields(n, "typed")}}`,
        rows(n, (i) => [
          `let a${i}=shared`,
          `let b${i}=a${i}`,
          `a${i}=b${i}`,
          `let c${i}={f0:word}`,
          `let d${i}=c${i}`,
          `c${i}=d${i}`,
          `let e${i}={f0:flag}`,
          `let f${i}=e${i}`,
          `e${i}=f${i}`,
          `c${i}=a${i}`,
          `e${i}=c${i}`,
          `a${i}=e${i}`,
          `b${i}=b${i}`,
          `let box${i}={a:b${i},b:d${i},c:f${i}}`,
          `let final${i}=[box${i}.a,box${i}.b,box${i}.c]`,
        ]),
      ),
  };
  return {
    shapes: {
      "rejected-relay-literal": (n) => shapes["rejected-relay-literal"](n),
      "dormant-meetings-literal": (n) => shapes["dormant-meetings-literal"](n),
      "dormant-meetings-place": (n) => shapes["dormant-meetings-place"](n),
      "three-groups-self": (n) => shapes["three-groups-self"](n),
    },
  };
})();
export const shapes = corpus.shapes;
export const checks = ["publication"];
