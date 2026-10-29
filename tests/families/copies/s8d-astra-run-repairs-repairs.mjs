// Astra review: 13 fixed repairs source cases.
const corpus = (() => {
  const repairs = [
    ["union-variable", "let season", /as '([^']*)'/],
    ["union-list", "let tickets", /as '([^']*)'/],
    ["union-dict", "let prices", /as '([^']*)'/],
    ["shown-object", "${badge}", /as in '([^']*)'/, ["Visitor"]],
    ["shown-optional-property", "${badge}", /as in '([^']*)'/, ["null"]],
    ["shown-set", "${badges}", /with '([^']*)'/],
    ["shown-computed-set", "${set[4, 7]}", /with '([^']*)'/],
    ["set-composed", "${badges otherwise set[4, 7]}", /with '([^']*)'/],
    ["shown-mixed-shapes", "${badge}", /as in '([^']*)'/, ["7", "8"]],
    ["shown-property-changed", "${badge}", /as in '([^']*)'/, ["8"]],
    ["condition-number", "if distance", /as in '([^']*)'/],
    ["condition-text", "if caption", /as in '([^']*)'/],
    ["condition-list", "if badges", /as in '([^']*)'/],
    ["key-number", "prices[-4]", /as in '([^']*)'/],
    ["convert-text", "badge.length", /as in '([^']*)'/],
    ["convert-duration", "(gap * 3).milliseconds", /as in '([^']*)'/],
    ["convert-date-field", "(stamp + 9 s).month", /as in '([^']*)'/],
    ["date-add", "4 days", /Write '([^']*)'/],
    ["datetime-add", "stamp + 9 s", /as in '([^']*)'/],
    ["absolute-add", "stamp + 2 calendar months", /as in '([^']*)'/],
    ["date-compare", "birthday > stamp", /as in '([^']*)'/],
    ["datetime-subtract", 'stamp - toDateTime("2025-05-16T08:00:00")', /dates with '([^']*)'/],
    ["speaker-method", "guide.get(4, default: 9)", /such as '([^']*)'/, ["Guide"]],
    ["null-arithmetic-flow", "say credit * 4", /fallback, as in '([^']*)'/, ["0"]],
  ];
  return {
    cases: [
      ["union-variable", repairs["0"][1]],
      ["union-list", repairs["1"][1]],
      ["union-dict", repairs["2"][1]],
      ["0", repairs["3"]["0"]],
      ["0", repairs["4"]["0"]],
      ["0", repairs["5"]["0"]],
      ["0", repairs["6"]["0"]],
      ["0", repairs["8"]["0"]],
      ["0", repairs["9"]["0"]],
      ["condition-number", repairs["10"][1]],
      ["condition-text", repairs["11"][1]],
      ["condition-list", repairs["12"][1]],
      ["null-arithmetic-flow", repairs["23"][1]],
    ],
  };
})();
export const cases = corpus.cases;
export const checks = ["publication"];
