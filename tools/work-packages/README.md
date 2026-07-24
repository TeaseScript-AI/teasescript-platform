# Work-package fallback

**Status:** Explicit fallback only  
**Primary workflow:** `docs/DEVELOPMENT-WORKFLOW.md`

Use GitHub issues, branches, commits, pull requests, reviews, and CI by default. Use this work-package flow only when the assigned implementation agent cannot create the required GitHub branch, commits, or pull request, or when the owner explicitly requires a reproducible external patch handoff.

Do not create a work package merely because a task is difficult or because several agents are available. Issue sizing and agent-count rules do not change in fallback mode:

```text
one coherent issue
    -> one authoring agent
    -> one work package
    -> one target branch
    -> one pull request
```

Coordinated multi-agent fallback work is allowed only when the owner or coordinator has already selected the coordinated model described in `docs/DEVELOPMENT-WORKFLOW.md`.

## 1. What this tooling does

The repository contains:

```text
tools/work-packages/
├── integrate.sh
├── README.md
├── PACKAGE.schema.json
└── templates/
    ├── PACKAGE.example.json
    ├── CODEX-INSTRUCTIONS.template.md
    └── HANDOFF.template.md
```

`integrate.sh` validates a prepared patch package, applies it in a temporary Git worktree, runs declared checks, creates one commit, and fast-forwards the already checked-out target branch when everything passes.

The runner does **not**:

- design or repair implementation;
- create `CHANGE.patch` or fill `PACKAGE.json`;
- select scope, branch, or base commit;
- push a branch;
- open or merge a pull request;
- update issue or pull-request descriptions;
- make product, architecture, or language decisions.

A successful local integration must still be pushed and reviewed through the normal GitHub pull-request workflow by a GitHub-capable user or agent.

## 2. Roles

### Owner or coordinator

The owner or coordinator explicitly selects fallback mode and supplies:

- repository;
- accepted issue or workstream;
- target branch;
- exact base commit SHA;
- scope and exclusions;
- acceptance criteria;
- expected checks;
- documentation ownership.

For an ordinary single-agent issue, no milestone coordinator or integration branch is needed. The target branch normally corresponds to the issue and will later open a pull request to `main`.

### Authoring agent

The authoring agent follows `AGENTS.md`, reads the task authority at the exact base revision, implements the change, and produces the work package.

The agent must not treat the runner as a substitute for understanding the repository or for writing focused tests.

### Integrator

Codex or another local integrator:

- extracts the package outside the repository;
- switches to the exact target branch;
- reads the required integration context;
- runs the repository runner;
- returns the bounded success or failure result;
- does not silently repair or redesign a failed package.

### GitHub-capable publisher

After a successful integration, a GitHub-capable user or agent:

- reviews the resulting commit and complete diff;
- pushes the target branch;
- opens or updates the pull request;
- records verification, documentation impact, deferred work, and risks;
- follows the normal review and merge rules in `docs/DEVELOPMENT-WORKFLOW.md`.

One person or agent may hold more than one role, but the responsibility boundaries remain the same.

## 3. Package and file locations

Work packages remain outside the Git repository, for example:

```text
~/work-packages/issue-123/WP-ISSUE-123-v1/
├── PACKAGE.json
├── CHANGE.patch
└── CODEX-INSTRUCTIONS.md
```

Do not place ZIP files, extracted packages, temporary logs, or handoff reports inside the repository.

A package ZIP contains exactly these three files at its root:

```text
PACKAGE.json
CHANGE.patch
CODEX-INSTRUCTIONS.md
```

A separate handoff report is optional for a normal single-agent fallback. Use `templates/HANDOFF.template.md` when the authoring agent cannot directly maintain the pull-request description, or when a coordinated fallback assignment requires a structured report.

## 4. Platform requirements

The current runner targets a Linux environment and requires:

- Bash 4 or newer;
- Git;
- `jq`;
- GNU-compatible `base64 --decode`;
- standard Unix tools used by the script;
- `unzip` for ZIP extraction;
- the repository's configured runtime tools.

For this repository, prepare the environment with:

```bash
nvm use
npm ci
```

Git also needs a usable commit identity:

```bash
git config user.name
git config user.email
```

## 5. Authoring a package

### 5.1 Lock the assignment

Record the exact values supplied for the task:

```text
repository: TeaseScript-AI/teasescript-platform
target branch: <assigned branch>
base SHA: <full 40-character SHA>
issue or workstream: <assigned scope only>
```

Use `basePolicy: "exact"` unless the assignment explicitly permits another policy.

Do not silently change the branch, base SHA, scope, exclusions, or accepted behavior.

### 5.2 Read repository authority

Follow `AGENTS.md` before changing files. This normally includes:

- `README-FIRST.md`;
- `CURRENT-DESIGN.md`;
- `PHASE-STATUS.md`;
- the task-specific document;
- relevant accepted ADRs;
- accepted syntax when language behavior is involved;
- open decisions or backlog entries when the assignment depends on them.

`PACKAGE.json.requiredContext` is different: it lists only the small integration instructions the local integrator must read. It does not replace the authoring agent's repository reading.

For normal packages use:

```json
"requiredContext": [
  "AGENTS.md",
  "tools/work-packages/README.md"
]
```

### 5.3 Implement and verify

Implement only the assigned code, tests, fixtures, examples, and documentation. Run every check available in the authoring environment and report checks that could not be run instead of claiming success.

### 5.4 Create `CHANGE.patch`

`CHANGE.patch` is a normal Git unified diff against the exact `baseSha`, not a `git format-patch` email patch.

From a clean checkout at the assigned base:

```bash
git switch <target-branch>
test "$(git rev-parse HEAD)" = "<base-sha>"
```

Mark new files as intent-to-add so they appear in the diff:

```bash
git add -N -- path/to/new-file.ts
```

Generate a binary-safe full-index patch restricted to the declared paths:

```bash
git diff \
  --binary \
  --full-index \
  --no-ext-diff \
  <base-sha> \
  -- path/one.ts path/two.test.ts \
  > CHANGE.patch
```

Requirements:

- the patch is non-empty;
- paths are repository-relative;
- `allowedPaths` contains every changed old and new path;
- generated output, dependencies, secrets, editor files, and unrelated formatting are excluded;
- renames include both old and new paths;
- deletions include the old path;
- text files use repository line-ending rules.

An authoring environment without a local checkout may construct the patch from exact GitHub file contents, but it must use the assigned base revision and real blob SHAs. It must not invent hashes or claim tests it did not run.

### 5.5 Fill `PACKAGE.json`

Start from `templates/PACKAGE.example.json`. The authoring agent fills the manifest; the runner does not generate it.

Required fields include:

- package format and version;
- package ID and title;
- repository and target branch;
- exact base SHA and base policy;
- required integration-context files;
- allowed paths;
- base blob SHA or `null` for every allowed path;
- checks as argument arrays;
- commit subject and optional body.

`baseBlobs` keys must exactly match `allowedPaths`.

For an existing path, record its Git blob SHA at `baseSha`:

```bash
git rev-parse <base-sha>:path/to/file.ts
```

Use `null` only when the path does not exist at the base revision.

Checks are executed without a shell. Use argument arrays such as:

```json
{
  "id": "full-check",
  "argv": ["npm", "run", "check"]
}
```

The current runner permits `npm`, `node`, `php`, and `composer` as check executables. When the patch changes npm dependency manifests, include `npm ci` before build or test checks.

### 5.6 Write `CODEX-INSTRUCTIONS.md`

Start from `templates/CODEX-INSTRUCTIONS.template.md`. Keep it operational and short. It must identify:

- package ZIP;
- extraction directory outside the repository;
- exact target branch and base SHA;
- runner commands;
- success response;
- failure response;
- prohibition on autonomous repair, push, merge, or pull-request creation unless separately assigned.

### 5.7 Optional handoff report

Use `templates/HANDOFF.template.md` only when another person or agent must reconstruct the pull-request description or coordinated status from the package result.

The report must distinguish:

- intended or final behavior;
- tests included;
- commands actually run by the author;
- checks delegated to the runner;
- documentation impact;
- changed or deferred scope;
- remaining risks;
- successful commit SHA once known.

### 5.8 Create and inspect the ZIP

Create the ZIP with the three required files at its root:

```bash
zip -j WP-ISSUE-123-v1.zip \
  PACKAGE.json \
  CHANGE.patch \
  CODEX-INSTRUCTIONS.md
```

Inspect it before delivery:

```bash
unzip -l WP-ISSUE-123-v1.zip
```

## 6. Integrating a package

Extract the ZIP outside the repository:

```bash
mkdir -p ~/work-packages/issue-123/WP-ISSUE-123-v1
unzip WP-ISSUE-123-v1.zip \
  -d ~/work-packages/issue-123/WP-ISSUE-123-v1
```

Enter the repository, switch to the target branch, and confirm the working tree is clean.

Check integration context:

```bash
bash tools/work-packages/integrate.sh \
  context ~/work-packages/issue-123/WP-ISSUE-123-v1
```

Exit code `3` means required context is unread or stale, not that the implementation failed. Read only the listed files, then record the context:

```bash
bash tools/work-packages/integrate.sh \
  bootstrap ~/work-packages/issue-123/WP-ISSUE-123-v1
```

Apply and verify the package:

```bash
bash tools/work-packages/integrate.sh \
  apply ~/work-packages/issue-123/WP-ISSUE-123-v1
```

The runner validates:

- package schema and allowed manifest fields;
- repository, branch, base policy, and clean live tree;
- required integration context;
- allowed paths and base blob preimages;
- staged patch contents and whitespace;
- declared checks;
- post-check tracked and untracked hygiene;
- commit creation and safe fast-forward of the live target branch.

It performs patch application and checks in a detached temporary worktree. A failed package leaves the live target branch unchanged.

## 7. Result contracts

### Success

The integrator returns:

```text
PACKAGE: <package ID>
BRANCH: <target branch>
COMMIT: <commit SHA printed by the runner>
RESULT: PASS
CHECKS:
<runner PASS lines>
```

The GitHub-capable publisher then reviews the resulting branch, pushes it, and opens or updates the pull request.

### Failure

When the runner prints:

```text
=== WORK PACKAGE FAILURE ===
...
=== END WORK PACKAGE FAILURE ===
```

return the complete bounded block and stop. Do not edit, reset, repair, commit, retry with altered arguments, or continue to another package unless a new assignment explicitly requests investigation.

## 8. Repair flow

1. The integrator returns the bounded failure block.
2. The same authoring agent receives the failure unless ownership is explicitly reassigned.
3. The author determines whether the package or the assignment must change.
4. The author produces a complete replacement package with a higher revision number.
5. Any optional handoff report is revised to match the replacement.
6. The integrator runs the replacement package from the state required by its manifest.

Do not deliver a verbal repair in place of a complete replacement package.

## 9. Publishing, review, and merge

After successful local integration:

1. inspect the commit and full diff;
2. push the target branch;
3. open or update the pull request to the branch assigned by `docs/DEVELOPMENT-WORKFLOW.md`;
4. record scope, verification, documentation impact, deferred work, and remaining risks;
5. let GitHub CI run;
6. process review feedback through the normal branch and pull-request loop;
7. merge only after the ordinary approval and verification gates pass.

For a normal issue, the pull request normally targets `main` and may close that issue. For explicitly coordinated work, executor pull requests target the integration branch and only the final integration pull request closes the selected issues.

The fallback changes transport and local integration. It does not weaken issue sizing, review, CI, documentation, or merge requirements.

## 10. Cleanup

After the pull request is safely published and temporary evidence is no longer needed, remove extracted packages and ZIP files:

```bash
rm -rf ~/work-packages/issue-123
```

Do not commit package ZIPs, extracted directories, patches, temporary reports, or runner state. The runner stores its context state, logs, and temporary worktrees under Git metadata or temporary directories, not as repository content.
