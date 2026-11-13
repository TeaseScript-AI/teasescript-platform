// The cost report's cells and the one function that decides each one (HEAD 0 "Rules over an open set": every number
// names its route). A cell is one value of each axis; `classify` gives it either `required` or an exclusion with its
// reason, by the first rule that matches, and throws for a value outside the axes. The report requires data for every
// required cell and names every excluded one. A measured failure is a value: a pass/fail scenario's failing run is its
// cell's result, not an incomplete cell; incomplete is for a required record missing or failing validation.

export const AXES = {
  scenario: [
    "session",
    "sessionInstrumented",
    "aa",
    "taps",
    "bridge",
    "bridgeTaps",
    "keepHandler",
    "keepCompletion",
    "keepDurable",
    "demo",
    "delayedSmoke",
  ],
  script: ["CelebWorship", "DisciplineClinic", "demo", "smoke"],
  route: ["source", "plan"],
  backend: ["main", "worker"],
  engine: ["chromium", "firefox", "webkit", "pixel"],
};

/** The scenarios that run on the full Player, whose `worker` cells need L5i.1, L5i.7 and the activation candidate. */
const FULL_PLAYER = new Set([
  "session",
  "sessionInstrumented",
  "aa",
  "taps",
  "keepHandler",
  "keepCompletion",
  "keepDurable",
  "demo",
  "delayedSmoke",
]);
const SCRIPT_OF = {
  session: ["CelebWorship", "DisciplineClinic"],
  sessionInstrumented: ["CelebWorship", "DisciplineClinic"],
  aa: ["CelebWorship"],
  taps: ["DisciplineClinic"],
  bridge: ["CelebWorship", "DisciplineClinic"],
  bridgeTaps: ["DisciplineClinic"],
  keepHandler: ["CelebWorship"],
  keepCompletion: ["CelebWorship"],
  keepDurable: ["CelebWorship"],
  demo: ["demo"],
  delayedSmoke: ["smoke"],
};

/** The rules, in order; the first whose `when` holds decides. `reason: null` makes the cell required. */
const RULES = [
  {
    name: "script",
    when: (cell) => !SCRIPT_OF[cell.scenario].includes(cell.script),
    reason: "not a script this scenario runs",
  },
  {
    name: "route",
    when: (cell) => cell.route === "plan" && FULL_PLAYER.has(cell.scenario),
    reason: "the full Player prepares source only",
  },
  {
    name: "touch",
    when: (cell) =>
      (cell.scenario === "taps" || cell.scenario === "bridgeTaps") &&
      (cell.engine === "firefox" || cell.engine === "webkit"),
    reason: "no CDP touch input",
  },
  {
    name: "real hidden page",
    when: (cell) => cell.scenario === "keepHandler" && cell.engine === "pixel",
    reason: "the Pixel hides the page for real (keepCompletion, keepDurable)",
  },
  {
    name: "phone only",
    when: (cell) =>
      (cell.scenario === "keepCompletion" || cell.scenario === "keepDurable") &&
      cell.engine !== "pixel",
    reason: "only the Pixel hides a page for real",
  },
  {
    name: "smoke engine",
    when: (cell) => cell.scenario === "delayedSmoke" && cell.engine !== "chromium",
    reason: "the browser smoke is Chromium's",
  },
  {
    name: "aa engines",
    when: (cell) =>
      cell.scenario === "aa" &&
      (cell.engine === "firefox" || cell.engine === "webkit" || cell.backend === "worker"),
    reason: "the probe's overhead is estimated once per device class, on the main backend",
  },
  {
    name: "worker Player",
    when: (cell, phase) =>
      phase === "r0" && cell.backend === "worker" && FULL_PLAYER.has(cell.scenario),
    reason: "open until L5i.1, L5i.7 and the activation candidate (session split S2's HEAD 0)",
  },
];

/** The decision for `cell` in `phase` (`r0` or `r1`): `{ required: true }` or `{ required: false, rule, reason }`. */
export function classify(cell, phase) {
  for (const [axis, values] of Object.entries(AXES))
    if (!values.includes(cell[axis]))
      throw new Error(`'${cell[axis]}' is no value of the axis '${axis}'`);
  if (phase !== "r0" && phase !== "r1") throw new Error(`'${phase}' is no phase (r0, r1)`);
  for (const rule of RULES)
    if (rule.when(cell, phase)) return { required: false, rule: rule.name, reason: rule.reason };
  return { required: true };
}

/** Every cell of the axes, in a fixed order. */
export function allCells() {
  let cells = [{}];
  for (const [axis, values] of Object.entries(AXES))
    cells = cells.flatMap((cell) => values.map((value) => ({ ...cell, [axis]: value })));
  return cells;
}

/** A cell's name: its axis values joined, in the axes' order. */
export const cellName = (cell) =>
  Object.keys(AXES)
    .map((axis) => cell[axis])
    .join(" / ");
