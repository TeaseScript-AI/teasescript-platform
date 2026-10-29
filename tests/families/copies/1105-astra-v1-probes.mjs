// #1105, Astra review (R/astra-m4-i1105-review/scripts/independent.mjs:28): the V1 probe files, each case that reads
// a host value with its own 'let hostValue = ...' prelude, compiled without globals.
export const checks = ["publication"];

// The probe files as independent.mjs wrote and compiled them.
const captured = [
  [
    "toNumber-host-fallback",
    'let hostValue = 0.0\nlet text = "7,25"\nlet result = toNumber(text, default: hostValue)\nexit\n',
  ],
  [
    "toNumber-host-fallback-unused",
    'let hostValue = 0.0\nlet text = "  +7.25e1  "\nlet result = toNumber(text, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toInteger-host-fallback",
    'let hostValue = 0\nlet text = "0x10"\nlet result = toInteger(text, default: hostValue)\nexit\n',
  ],
  [
    "toInteger-host-fallback-unused",
    'let hostValue = 0\nlet text = " -8.75 "\nlet result = toInteger(text, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toBoolean-host-fallback",
    'let hostValue = false\nlet text = "TRUE"\nlet result = toBoolean(text, default: hostValue)\nexit\n',
  ],
  [
    "toBoolean-host-fallback-unused",
    'let hostValue = false\nlet text = " false "\nlet result = toBoolean(text, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toDate-default-literal",
    'let hostValue = toDate("2000-02-29")\nlet result = toDate("2100-02-29", default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toDate-default-copies",
    'let hostValue = toDate("2000-02-29")\nlet seed = "2100-02-29"\nlet next = seed\nlet last = next\nlet result = toDate(last, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toDate-default-valid-copies",
    'let hostValue = toDate("2000-02-29")\nlet seed = "2000-02-29"\nlet next = seed\nlet last = next\nlet result = toDate(last, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toDate-typed-parentheses",
    'let hostValue = toDate("2000-02-29")\nlet text: string = "2100-02-29"\nlet result = toDate((text), default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toDate-two-step",
    'let hostValue = toDate("2000-02-29")\nlet prefix = "2100-02-2"\nlet text = prefix + "9"\nlet result = toDate(text, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toDate-interpolation",
    'let hostValue = toDate("2000-02-29")\nlet text = "2100-02-29"\nlet result = toDate("${text}", default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toDate-loop-invariant",
    'let hostValue = toDate("2000-02-29")\nlet seed = "2100-02-29"\nrepeat 2 {\nlet text = seed\nlet result = toDate(text, default: hostValue)\nsay "done"\n}\nexit\n',
  ],
  [
    "toDate-loop-written",
    'let hostValue = toDate("2000-02-29")\nlet text = "2000-02-29"\nrepeat 2 { text = "2100-02-29" }\nlet result = toDate(text, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toDate-loop-built",
    'let hostValue = toDate("2000-02-29")\nlet text = "2100-02-2"\nrepeat 1 { text = text + "9" }\nlet result = toDate(text, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toDate-branch-merged",
    'let hostValue = toDate("2000-02-29")\nlet text = "2100-02-29"\nif load("flag", default: false) { text = "2100-02-29" }\nlet result = toDate(text, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toDate-reassigned-valid",
    'let hostValue = toDate("2000-02-29")\nlet text = "2100-02-29"\ntext = "2000-02-29"\nlet result = toDate(text, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toDate-assigned-after",
    'let hostValue = toDate("2000-02-29")\nlet text = "2100-02-29"\nlet result = toDate(text, default: hostValue)\nsay "done"\ntext = "2000-02-29"\nexit\n',
  ],
  [
    "toDate-dead",
    'let hostValue = toDate("2000-02-29")\nlet text = "2100-02-29"\nif false {\nlet result = toDate(text, default: hostValue)\nsay "done"\n}\nexit\n',
  ],
  [
    "toDate-loaded",
    'let hostValue = toDate("2000-02-29")\nlet text = load("input", default: "2100-02-29")\nlet result = toDate(text, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toDate-host-fallback",
    'let hostValue = toDate("2000-02-29")\nlet text = "2100-02-29"\nlet result = toDate(text, default: hostValue)\nexit\n',
  ],
  [
    "toDate-host-fallback-unused",
    'let hostValue = toDate("2000-02-29")\nlet text = "2000-02-29"\nlet result = toDate(text, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toDate-parameter",
    'let hostValue = toDate("2000-02-29")\nfunction convert(text) {\nreturn toDate(text, default: hostValue)\n}\nlet result = convert("2100-02-29")\nsay "done"\nexit\n',
  ],
  [
    "toTime-default-literal",
    'let hostValue = toTime("23:59:59.125")\nlet result = toTime("23:59:60", default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toTime-default-copies",
    'let hostValue = toTime("23:59:59.125")\nlet seed = "23:59:60"\nlet next = seed\nlet last = next\nlet result = toTime(last, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toTime-default-valid-copies",
    'let hostValue = toTime("23:59:59.125")\nlet seed = "23:59:59.125"\nlet next = seed\nlet last = next\nlet result = toTime(last, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toTime-typed-parentheses",
    'let hostValue = toTime("23:59:59.125")\nlet text: string = "23:59:60"\nlet result = toTime((text), default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toTime-two-step",
    'let hostValue = toTime("23:59:59.125")\nlet prefix = "23:59:6"\nlet text = prefix + "0"\nlet result = toTime(text, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toTime-interpolation",
    'let hostValue = toTime("23:59:59.125")\nlet text = "23:59:60"\nlet result = toTime("${text}", default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toTime-loop-invariant",
    'let hostValue = toTime("23:59:59.125")\nlet seed = "23:59:60"\nrepeat 2 {\nlet text = seed\nlet result = toTime(text, default: hostValue)\nsay "done"\n}\nexit\n',
  ],
  [
    "toTime-loop-written",
    'let hostValue = toTime("23:59:59.125")\nlet text = "23:59:59.125"\nrepeat 2 { text = "23:59:60" }\nlet result = toTime(text, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toTime-loop-built",
    'let hostValue = toTime("23:59:59.125")\nlet text = "23:59:6"\nrepeat 1 { text = text + "0" }\nlet result = toTime(text, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toTime-branch-merged",
    'let hostValue = toTime("23:59:59.125")\nlet text = "23:59:60"\nif load("flag", default: false) { text = "23:59:60" }\nlet result = toTime(text, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toTime-reassigned-valid",
    'let hostValue = toTime("23:59:59.125")\nlet text = "23:59:60"\ntext = "23:59:59.125"\nlet result = toTime(text, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toTime-assigned-after",
    'let hostValue = toTime("23:59:59.125")\nlet text = "23:59:60"\nlet result = toTime(text, default: hostValue)\nsay "done"\ntext = "23:59:59.125"\nexit\n',
  ],
  [
    "toTime-dead",
    'let hostValue = toTime("23:59:59.125")\nlet text = "23:59:60"\nif false {\nlet result = toTime(text, default: hostValue)\nsay "done"\n}\nexit\n',
  ],
  [
    "toTime-loaded",
    'let hostValue = toTime("23:59:59.125")\nlet text = load("input", default: "23:59:60")\nlet result = toTime(text, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toTime-host-fallback",
    'let hostValue = toTime("23:59:59.125")\nlet text = "23:59:60"\nlet result = toTime(text, default: hostValue)\nexit\n',
  ],
  [
    "toTime-host-fallback-unused",
    'let hostValue = toTime("23:59:59.125")\nlet text = "23:59:59.125"\nlet result = toTime(text, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toTime-parameter",
    'let hostValue = toTime("23:59:59.125")\nfunction convert(text) {\nreturn toTime(text, default: hostValue)\n}\nlet result = convert("23:59:60")\nsay "done"\nexit\n',
  ],
  [
    "toDateTime-default-literal",
    'let hostValue = toDateTime("2028-04-30T23:59")\nlet result = toDateTime("2028-04-31T23:59", default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toDateTime-default-copies",
    'let hostValue = toDateTime("2028-04-30T23:59")\nlet seed = "2028-04-31T23:59"\nlet next = seed\nlet last = next\nlet result = toDateTime(last, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toDateTime-default-valid-copies",
    'let hostValue = toDateTime("2028-04-30T23:59")\nlet seed = "2028-04-30T23:59"\nlet next = seed\nlet last = next\nlet result = toDateTime(last, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toDateTime-typed-parentheses",
    'let hostValue = toDateTime("2028-04-30T23:59")\nlet text: string = "2028-04-31T23:59"\nlet result = toDateTime((text), default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toDateTime-two-step",
    'let hostValue = toDateTime("2028-04-30T23:59")\nlet prefix = "2028-04-31T23:5"\nlet text = prefix + "9"\nlet result = toDateTime(text, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toDateTime-interpolation",
    'let hostValue = toDateTime("2028-04-30T23:59")\nlet text = "2028-04-31T23:59"\nlet result = toDateTime("${text}", default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toDateTime-loop-invariant",
    'let hostValue = toDateTime("2028-04-30T23:59")\nlet seed = "2028-04-31T23:59"\nrepeat 2 {\nlet text = seed\nlet result = toDateTime(text, default: hostValue)\nsay "done"\n}\nexit\n',
  ],
  [
    "toDateTime-loop-written",
    'let hostValue = toDateTime("2028-04-30T23:59")\nlet text = "2028-04-30T23:59"\nrepeat 2 { text = "2028-04-31T23:59" }\nlet result = toDateTime(text, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toDateTime-loop-built",
    'let hostValue = toDateTime("2028-04-30T23:59")\nlet text = "2028-04-31T23:5"\nrepeat 1 { text = text + "9" }\nlet result = toDateTime(text, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toDateTime-branch-merged",
    'let hostValue = toDateTime("2028-04-30T23:59")\nlet text = "2028-04-31T23:59"\nif load("flag", default: false) { text = "2028-04-31T23:59" }\nlet result = toDateTime(text, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toDateTime-reassigned-valid",
    'let hostValue = toDateTime("2028-04-30T23:59")\nlet text = "2028-04-31T23:59"\ntext = "2028-04-30T23:59"\nlet result = toDateTime(text, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toDateTime-assigned-after",
    'let hostValue = toDateTime("2028-04-30T23:59")\nlet text = "2028-04-31T23:59"\nlet result = toDateTime(text, default: hostValue)\nsay "done"\ntext = "2028-04-30T23:59"\nexit\n',
  ],
  [
    "toDateTime-dead",
    'let hostValue = toDateTime("2028-04-30T23:59")\nlet text = "2028-04-31T23:59"\nif false {\nlet result = toDateTime(text, default: hostValue)\nsay "done"\n}\nexit\n',
  ],
  [
    "toDateTime-loaded",
    'let hostValue = toDateTime("2028-04-30T23:59")\nlet text = load("input", default: "2028-04-31T23:59")\nlet result = toDateTime(text, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toDateTime-host-fallback",
    'let hostValue = toDateTime("2028-04-30T23:59")\nlet text = "2028-04-31T23:59"\nlet result = toDateTime(text, default: hostValue)\nexit\n',
  ],
  [
    "toDateTime-host-fallback-unused",
    'let hostValue = toDateTime("2028-04-30T23:59")\nlet text = "2028-04-30T23:59"\nlet result = toDateTime(text, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toDateTime-parameter",
    'let hostValue = toDateTime("2028-04-30T23:59")\nfunction convert(text) {\nreturn toDateTime(text, default: hostValue)\n}\nlet result = convert("2028-04-31T23:59")\nsay "done"\nexit\n',
  ],
  [
    "toAbsoluteDateTime-default-literal",
    'let hostValue = toAbsoluteDateTime("2028-04-30T23:59:59+02:30")\nlet result = toAbsoluteDateTime("2028-04-30T23:59", default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toAbsoluteDateTime-default-copies",
    'let hostValue = toAbsoluteDateTime("2028-04-30T23:59:59+02:30")\nlet seed = "2028-04-30T23:59"\nlet next = seed\nlet last = next\nlet result = toAbsoluteDateTime(last, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toAbsoluteDateTime-default-valid-copies",
    'let hostValue = toAbsoluteDateTime("2028-04-30T23:59:59+02:30")\nlet seed = "2028-04-30T23:59:59+02:30"\nlet next = seed\nlet last = next\nlet result = toAbsoluteDateTime(last, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toAbsoluteDateTime-typed-parentheses",
    'let hostValue = toAbsoluteDateTime("2028-04-30T23:59:59+02:30")\nlet text: string = "2028-04-30T23:59"\nlet result = toAbsoluteDateTime((text), default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toAbsoluteDateTime-two-step",
    'let hostValue = toAbsoluteDateTime("2028-04-30T23:59:59+02:30")\nlet prefix = "2028-04-30T23:5"\nlet text = prefix + "9"\nlet result = toAbsoluteDateTime(text, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toAbsoluteDateTime-interpolation",
    'let hostValue = toAbsoluteDateTime("2028-04-30T23:59:59+02:30")\nlet text = "2028-04-30T23:59"\nlet result = toAbsoluteDateTime("${text}", default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toAbsoluteDateTime-loop-invariant",
    'let hostValue = toAbsoluteDateTime("2028-04-30T23:59:59+02:30")\nlet seed = "2028-04-30T23:59"\nrepeat 2 {\nlet text = seed\nlet result = toAbsoluteDateTime(text, default: hostValue)\nsay "done"\n}\nexit\n',
  ],
  [
    "toAbsoluteDateTime-loop-written",
    'let hostValue = toAbsoluteDateTime("2028-04-30T23:59:59+02:30")\nlet text = "2028-04-30T23:59:59+02:30"\nrepeat 2 { text = "2028-04-30T23:59" }\nlet result = toAbsoluteDateTime(text, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toAbsoluteDateTime-loop-built",
    'let hostValue = toAbsoluteDateTime("2028-04-30T23:59:59+02:30")\nlet text = "2028-04-30T23:5"\nrepeat 1 { text = text + "9" }\nlet result = toAbsoluteDateTime(text, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toAbsoluteDateTime-branch-merged",
    'let hostValue = toAbsoluteDateTime("2028-04-30T23:59:59+02:30")\nlet text = "2028-04-30T23:59"\nif load("flag", default: false) { text = "2028-04-30T23:59" }\nlet result = toAbsoluteDateTime(text, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toAbsoluteDateTime-reassigned-valid",
    'let hostValue = toAbsoluteDateTime("2028-04-30T23:59:59+02:30")\nlet text = "2028-04-30T23:59"\ntext = "2028-04-30T23:59:59+02:30"\nlet result = toAbsoluteDateTime(text, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toAbsoluteDateTime-assigned-after",
    'let hostValue = toAbsoluteDateTime("2028-04-30T23:59:59+02:30")\nlet text = "2028-04-30T23:59"\nlet result = toAbsoluteDateTime(text, default: hostValue)\nsay "done"\ntext = "2028-04-30T23:59:59+02:30"\nexit\n',
  ],
  [
    "toAbsoluteDateTime-dead",
    'let hostValue = toAbsoluteDateTime("2028-04-30T23:59:59+02:30")\nlet text = "2028-04-30T23:59"\nif false {\nlet result = toAbsoluteDateTime(text, default: hostValue)\nsay "done"\n}\nexit\n',
  ],
  [
    "toAbsoluteDateTime-loaded",
    'let hostValue = toAbsoluteDateTime("2028-04-30T23:59:59+02:30")\nlet text = load("input", default: "2028-04-30T23:59")\nlet result = toAbsoluteDateTime(text, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toAbsoluteDateTime-host-fallback",
    'let hostValue = toAbsoluteDateTime("2028-04-30T23:59:59+02:30")\nlet text = "2028-04-30T23:59"\nlet result = toAbsoluteDateTime(text, default: hostValue)\nexit\n',
  ],
  [
    "toAbsoluteDateTime-host-fallback-unused",
    'let hostValue = toAbsoluteDateTime("2028-04-30T23:59:59+02:30")\nlet text = "2028-04-30T23:59:59+02:30"\nlet result = toAbsoluteDateTime(text, default: hostValue)\nsay "done"\nexit\n',
  ],
  [
    "toAbsoluteDateTime-parameter",
    'let hostValue = toAbsoluteDateTime("2028-04-30T23:59:59+02:30")\nfunction convert(text) {\nreturn toAbsoluteDateTime(text, default: hostValue)\n}\nlet result = convert("2028-04-30T23:59")\nsay "done"\nexit\n',
  ],
  [
    "c10-selected",
    'let hostValue = 4\nlet n = toInteger(load("t", default: "bad"), default: hostValue)\nsay "done"\nexit\n',
  ],
];
export const cases = captured;

// the globals the recorded run passed
export const globals = [];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      '/home/peter/opt/node-24.18/bin/node "$root/scripts/independent.mjs" "$root/$build" "$root/cases.json" "$root/results/final-$mode.jsonl" "$order"',
      "R/astra-m4-i1105-review/scripts/queue-cases.sh:8",
    ],
    [
      '/home/peter/opt/node-24.18/bin/node "$root/scripts/independent.mjs" "$root/head" "$root/cases.json" "$root/results/$mode.jsonl" "$mode"',
      "R/astra-m4-i1105-review/scripts/queue.sh:6",
    ],
    [
      '/home/peter/opt/node-24.18/bin/node "$root/scripts/independent.mjs" "$root/base" "$root/cases.json" "$root/results/base.jsonl" forward',
      "R/astra-m4-i1105-review/scripts/queue.sh:8",
    ],
  ],
  sources: 75,
  sha256: "b28d0d76f6d2c58265c941e1fe1407e7858c8fbe144e88ba2dca9cf35aa10a79",
};
