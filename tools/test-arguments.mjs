// Which of the arguments the test filter passes to `node --test` are test paths. Node reads options until the first
// argument that is not one, or until `--`, and every argument after that as a path, so a path the filter does not
// check could pass a focused run without running its test.

/** The Node options a focused run may pass that take no value. */
export const BOOLEAN_OPTIONS = new Set([
  "--test-only",
  "--test-force-exit",
  "--test-update-snapshots",
  "--test-randomize",
  "--experimental-test-coverage",
]);

/** The Node options a focused run may pass that take a value, also as the next argument (`--test-concurrency 1`). */
export const VALUE_OPTIONS = new Set([
  "--test-name-pattern",
  "--test-skip-pattern",
  "--test-concurrency",
  "--test-timeout",
  "--test-reporter",
  "--test-reporter-destination",
  "--test-shard",
  "--test-isolation",
  "--test-random-seed",
  "--import",
  "--require",
  "-r",
]);

/**
 * The arguments among `args` that Node reads as test paths. Before the first path or `--`: a long option written
 * `--name=value` is whole (Node refuses one it does not know); a value option takes the next argument as its value; any
 * other argument that starts with `-` is refused, since the filter cannot tell whether it takes a value. A long option's
 * `_` reads as `-`, as Node reads it (`--test_only` is `--test-only`). From the first path or `--` on, every argument is
 * a path.
 */
export function testPathArguments(args) {
  const paths = [];
  let options = true;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const name = argument.startsWith("--") ? argument.replaceAll("_", "-") : argument;
    if (!options) paths.push(argument);
    else if (argument === "--") options = false;
    else if (argument.startsWith("--") && argument.includes("=")) continue;
    else if (BOOLEAN_OPTIONS.has(name)) continue;
    // (Node refuses a value option whose next argument starts with `-`, so that run fails whatever this decides.)
    else if (VALUE_OPTIONS.has(name)) index += 1;
    else if (argument.startsWith("-"))
      throw new Error(
        `'${argument}' is not an option it knows; give a Node option's value with '=', as in '--test-name-pattern=name'`,
      );
    else {
      options = false;
      paths.push(argument);
    }
  }
  return paths;
}
