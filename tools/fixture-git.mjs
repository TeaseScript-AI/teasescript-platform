/**
 * `environment` with the host's git setup kept out, for a test's fixture repositories: without each `GIT_*` variable,
 * git reading no global, XDG or system configuration, and no user or system ignore or attributes file (whose default
 * paths under `XDG_CONFIG_HOME` or `HOME` git reads without any configuration), and committing as `t <t@t>`. No host
 * hook path, template, signing, default branch, file-system monitor, ignore pattern, attribute or user setting then
 * reaches a fixture.
 */
export function gitIsolated(environment) {
  return {
    ...Object.fromEntries(Object.entries(environment).filter(([name]) => !name.startsWith("GIT_"))),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.excludesFile",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_KEY_1: "core.attributesFile",
    GIT_CONFIG_VALUE_1: "/dev/null",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
}

/**
 * Makes this process's environment `gitIsolated`, so that every git and tool process the test starts inherits it. A
 * test file that does not pass its own environment to each process calls it once, before any git runs.
 */
export function isolateGit() {
  const isolated = gitIsolated(process.env);
  for (const name of Object.keys(process.env)) if (!(name in isolated)) delete process.env[name];
  Object.assign(process.env, isolated);
}
