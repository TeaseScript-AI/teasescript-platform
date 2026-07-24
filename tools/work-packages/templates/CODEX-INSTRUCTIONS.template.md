# Work-package integration instructions — {{PACKAGE_ID}}

Act only as the local work-package integrator. Do not redesign or repair `CHANGE.patch` unless the owner explicitly changes the task to investigation.

## Package

- ZIP: `{{ZIP_FILENAME}}`
- extraction directory: `{{PACKAGE_DIRECTORY_OUTSIDE_REPOSITORY}}`
- repository: `TeaseScript-AI/teasescript-platform`
- branch: `{{TARGET_BRANCH}}`
- expected base: `{{BASE_SHA}}`

## Procedure

1. Extract the ZIP outside the Git repository. The extracted directory must contain `PACKAGE.json`, `CHANGE.patch`, and this file at its root.
2. Enter the repository and switch to `{{TARGET_BRANCH}}`.
3. Confirm the live working tree is clean. Do not move or copy the package into the repository.
4. Run:

   ```bash
   bash tools/work-packages/integrate.sh context "{{PACKAGE_DIRECTORY_OUTSIDE_REPOSITORY}}"
   ```

5. When the runner prints `WORK PACKAGE CONTEXT REQUIRED`, read only the listed files. Then run:

   ```bash
   bash tools/work-packages/integrate.sh bootstrap "{{PACKAGE_DIRECTORY_OUTSIDE_REPOSITORY}}"
   ```

   Exit code `3` from `context` is not an implementation failure.

6. Run:

   ```bash
   bash tools/work-packages/integrate.sh apply "{{PACKAGE_DIRECTORY_OUTSIDE_REPOSITORY}}"
   ```

## Success response

Return only:

```text
PACKAGE: {{PACKAGE_ID}}
BRANCH: {{TARGET_BRANCH}}
COMMIT: <commit SHA printed by the runner>
RESULT: PASS
CHECKS:
<runner PASS lines>
```

Do not run another `git commit`; the runner already committed and fast-forwarded the branch. Do not push, merge, open a pull request, or continue to another package unless that is a separate explicit assignment.

## Failure response

When the runner prints a block from `=== WORK PACKAGE FAILURE ===` through `=== END WORK PACKAGE FAILURE ===`, copy that complete block verbatim and stop.

Do not edit, repair, reset, commit, retry with changed arguments, or continue to another package.
