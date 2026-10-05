# Verified packages

Converted packages that played correctly in the Player, automatically on several paths and in a manual check. Their
frozen copies in `external/verified/<unit>/` are served instead of later conversions; `tools/verify-package.ts` adds
a row. A newer conversion that fails where the verified copy passed is a regression to report, not a replacement.

| Unit | Date | Importer commit | Paths played |
| --- | --- | --- | --- |
| `CornerTimeDemo` | 2026-10-05 | 23bbf5e4 | 6 automated runs to the end (1/1 files, 10/10 interactions, 17 choices); manual: played by hand to the end with timers skipped: number input, choices, bell sound, image |
| `Denial_Assistant` | 2026-10-05 | 23bbf5e4 | 3 automated runs to the end (1/1 files, 11/12 interactions, 12 choices); manual: played by hand to the cum ending with timers skipped; images and the 10 s timer flow checked |
