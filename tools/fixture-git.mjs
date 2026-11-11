/**
 * `environment` with the host's git setup kept out, for a test's fixture repositories: without each `GIT_*` variable,
 * git reading no global, XDG or system configuration, and committing as `t <t@t>`. No host hook path, template,
 * signing, default branch, file-system monitor or user setting then reaches a fixture.
 */
export function gitIsolated(environment) {
  return {
    ...Object.fromEntries(Object.entries(environment).filter(([name]) => !name.startsWith("GIT_"))),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
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
