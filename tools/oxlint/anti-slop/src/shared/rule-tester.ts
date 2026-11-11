import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

// Each rule's cases run as node:test tests, so that a run counts and names them, and a file whose cases never ran fails
// it (`tools/test-output-filter.mjs`). Without these, `RuleTester` runs the cases as plain calls that node:test does not
// see.
// (node:test registers each one at the call; the promise it returns is the runner's, so it is not awaited here)
RuleTester.describe = (text, cases) => {
  void describe(text, cases);
};
RuleTester.it = (text, check) => {
  void it(text, check);
};
// (after `it`, whose setter clears it: a case with `only: true`, and `RuleTester.only`, use it)
RuleTester.itOnly = (text, check) => {
  void it.only(text, check);
};

export { RuleTester };
