export const cases = [
  ["original-1", 'let plant = {twig0: 1, quiet: "ok"}\nsay plant.twig0\nexit\n'],
  ["original-2", "let plant = [1]\nsay plant[0]\nexit\n"],
  [
    "original-3",
    'let plant = {twig0: [{twig2: 1, quiet: "ok"}], quiet: "ok"}\nsay plant.twig0[0].twig2\nexit\n',
  ],
  ["original-4", 'let plant = [{twig1: [1], quiet: "ok"}]\nsay plant[0].twig1[0]\nexit\n'],
  [
    "original-5",
    'let plant = {twig0: [{twig2: [{twig4: 1, quiet: "ok"}], quiet: "ok"}], quiet: "ok"}\nsay plant.twig0[0].twig2[0].twig4\nexit\n',
  ],
  [
    "original-6",
    'let plant = [{twig1: [{twig3: [1], quiet: "ok"}], quiet: "ok"}]\nsay plant[0].twig1[0].twig3[0]\nexit\n',
  ],
  ["original-7", "let plant = [{branch: [{leaf: 1}]}]\nsay plant.first.branch[0].leaf\nexit\n"],
  [
    "original-8",
    "let seed: integer? = null\nlet plant = {branch: {leaf: [seed]}}\nsay (plant.branch otherwise {leaf: [2]}).leaf[0]\nexit\n",
  ],
  [
    "original-9",
    'let plant = {left: [{leaf: 1}], right: [{leaf: "x"}]}\nsay plant.left[0].leaf\nsay plant.right[0].leaf\nsay plant.left[0].leaf\nexit\n',
  ],
  [
    "original-10",
    "let alpha = {branch: [{leaf: 1}]}\nlet beta = {branch: [{leaf: 2}]}\nsay alpha.branch[0].leaf\nsay beta.branch[0].leaf\nexit\n",
  ],
];

export const checks = ["publication", "stops"];
