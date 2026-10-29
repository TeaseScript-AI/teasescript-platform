// Astra review: size-dependent scaleCases source families.
export const sizes = [64, 128];
const corpus = (() => {
  const { scaleCases: scaleCases } = (() => {
    function scaleCases(k, depth = 3) {
      const rows = (fn) => Array.from({ length: k }, (_, i) => fn(i));
      const fields = rows((i) => `p${i}:1`).join(",");
      const setup =
        `let root={${fields}}\n` +
        rows((i) => `let a${i}=${i === 0 ? "root" : "a" + (i - 1)}`).join("\n");
      const demands = (name, at = "") => rows((i) => `repeat ${name}${at}.p${i} {}`).join("\n");
      const shapes = [
        [
          "aliases-choice",
          `askChoice ${rows((i) => `{text:"${i}",value:a${k - 1 - i}}`).join(",")}`,
          "",
        ],
        [
          "nested-selection",
          `askChoice ${rows((i) => `{text:"${i}",value:${"[".repeat(depth)}a${i}${"]".repeat(depth)}${".last".repeat(depth)}}`).join(",")}`,
          "",
        ],
        [
          "dict-copy",
          `askChoice ${rows((i) => `{text:"${i}",value:dict{key:a${i}}.values.takeLast(1).last}`).join(",")}`,
          "",
        ],
        [
          "parse-choice",
          `askChoice ${rows((i) => `{text:"${i}",value:fromJson("{}",default:a${i},files:false)}`).join(",")}`,
          "",
        ],
        [
          "get-other",
          `[${rows((i) => `[a${i}].get(4,default:(null otherwise a${k - 1 - i}))`).join(",")}]`,
          ".last",
        ],
      ];
      return shapes.map(([name, expr, at]) => ({
        name,
        files: [
          {
            path: "main.tease",
            source: setup + `\nlet out=${expr}\n` + demands("out", at) + "\nexit",
          },
        ],
      }));
    }
    return { scaleCases };
  })();
  return {
    shapes: {
      "aliases-choice": (n) => scaleCases(n)["0"].files,
      "nested-selection": (n) => scaleCases(n)["1"].files,
      "dict-copy": (n) => scaleCases(n)["2"].files,
      "parse-choice": (n) => scaleCases(n)["3"].files,
      "get-other": (n) => scaleCases(n)["4"].files,
    },
  };
})();
export const shapes = corpus.shapes;
export const checks = ["publication"];

export const cases = [
  [
    "original/1/original-11",
    'let root={p0:1,p1:1,p2:1,p3:1}\nlet a0=root\nlet a1=a0\nlet a2=a1\nlet a3=a2\nlet out=askChoice {text:"0",value:[[[[[[[[[[[[[[[[a0]]]]]]]]]]]]]]]].last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last},{text:"1",value:[[[[[[[[[[[[[[[[a1]]]]]]]]]]]]]]]].last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last},{text:"2",value:[[[[[[[[[[[[[[[[a2]]]]]]]]]]]]]]]].last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last},{text:"3",value:[[[[[[[[[[[[[[[[a3]]]]]]]]]]]]]]]].last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last}\nrepeat out.p0 {}\nrepeat out.p1 {}\nrepeat out.p2 {}\nrepeat out.p3 {}\nexit',
  ],
  [
    "original/2/original-12",
    'let root={p0:1,p1:1,p2:1,p3:1}\nlet a0=root\nlet a1=a0\nlet a2=a1\nlet a3=a2\nlet out=askChoice {text:"0",value:[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[a0]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]].last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last},{text:"1",value:[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[a1]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]].last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last},{text:"2",value:[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[a2]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]].last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last},{text:"3",value:[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[a3]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]].last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last}\nrepeat out.p0 {}\nrepeat out.p1 {}\nrepeat out.p2 {}\nrepeat out.p3 {}\nexit',
  ],
  [
    "original/3/original-13",
    'let root={p0:1,p1:1,p2:1,p3:1}\nlet a0=root\nlet a1=a0\nlet a2=a1\nlet a3=a2\nlet out=askChoice {text:"0",value:[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[a0]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]].last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last},{text:"1",value:[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[a1]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]].last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last},{text:"2",value:[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[a2]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]].last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last},{text:"3",value:[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[a3]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]].last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last.last}\nrepeat out.p0 {}\nrepeat out.p1 {}\nrepeat out.p2 {}\nrepeat out.p3 {}\nexit',
  ],
];
