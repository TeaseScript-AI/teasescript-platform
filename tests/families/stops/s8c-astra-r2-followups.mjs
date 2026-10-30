// S8c's review r2 (Astra): the stored-projection and guard-composition stops it followed up, from its own
// own-stops.jsonl (R/astra-m4-s8c-review-r2-evidence/worker/followups.mjs).
export const cases = [
  ["followups-j0-input1", "let tally = 1\ntally = 2\ntally = 3\ntally = 4\ntally = 5\ntally = 6\ntally = 7\ntally = 8\ntally = 9\ntally = 10\ntally = 11\ntally = 12\ntally = 13\ntally = 14\ntally = 15\ntally = 16\ntally = 17\ntally = 18\ntally = 19\ntally = 20\ntally = 21\ntally = 22\ntally = 23\ntally = 24\ntally = 25\ntally = 26\ntally = 27\ntally = 28\ntally = 29\ntally = 30\ntally = 31\ntally = 32\ntally = 33\ntally = 34\ntally = 35\ntally = 36\ntally = 37\ntally = 38\ntally = 39\ntally = 40\ntally = 41\ntally = 42\ntally = 43\ntally = 44\ntally = 45\ntally = 46\ntally = 47\ntally = 48\ntally = 49\ntally = 50\ntally = 51\ntally = 52\ntally = 53\ntally = 54\ntally = 55\ntally = 56\ntally = 57\ntally = 58\ntally = 59\ntally = 60\ntally = 61\ntally = 62\ntally = 63\ntally = 64\ntally = 65\ntally = 66\ntally = 67\ntally = 68\ntally = 69\ntally = 70\ntally = 71\ntally = 72\ntally = 73\ntally = 74\ntally = 75\ntally = 76\ntally = 77\ntally = 78\ntally = 79\ntally = 80\ntally = 81\ntally = hostValue\nlet packed = {payload: [tally]}\nlet copied = packed\nrepeat copied.payload.first {}\nlet count = 1\ncount = 0.5\nrepeat count {}\nsay \"DONE\"\nexit\n"],
  ["followups-j0-input2", "let tally = 1\ntally = 2\ntally = 3\ntally = 4\ntally = 5\ntally = 6\ntally = 7\ntally = 8\ntally = 9\ntally = 10\ntally = 11\ntally = 12\ntally = 13\ntally = 14\ntally = 15\ntally = 16\ntally = 17\ntally = 18\ntally = 19\ntally = 20\ntally = 21\ntally = 22\ntally = 23\ntally = 24\ntally = 25\ntally = 26\ntally = 27\ntally = 28\ntally = 29\ntally = 30\ntally = 31\ntally = 32\ntally = 33\ntally = 34\ntally = 35\ntally = 36\ntally = 37\ntally = 38\ntally = 39\ntally = 40\ntally = 41\ntally = 42\ntally = 43\ntally = 44\ntally = 45\ntally = 46\ntally = 47\ntally = 48\ntally = 49\ntally = 50\ntally = 51\ntally = 52\ntally = 53\ntally = 54\ntally = 55\ntally = 56\ntally = 57\ntally = 58\ntally = 59\ntally = 60\ntally = 61\ntally = 62\ntally = 63\ntally = 64\ntally = 65\ntally = 66\ntally = 67\ntally = 68\ntally = 69\ntally = 70\ntally = 71\ntally = 72\ntally = 73\ntally = 74\ntally = 75\ntally = 76\ntally = 77\ntally = 78\ntally = 79\ntally = 80\ntally = 81\ntally = hostValue\nif tally is integer { let packed = {payload: [tally]}\nrepeat packed.payload.first {} }\nrepeat tally {}\nlet count = 1\ncount = 0.5\nrepeat count {}\nsay \"DONE\"\nexit\n"],
  ["followups-j0-input3", "let tally = 1\ntally = 2\ntally = 3\ntally = 4\ntally = 5\ntally = 6\ntally = 7\ntally = 8\ntally = 9\ntally = 10\ntally = 11\ntally = 12\ntally = 13\ntally = 14\ntally = 15\ntally = 16\ntally = 17\ntally = 18\ntally = 19\ntally = 20\ntally = 21\ntally = 22\ntally = 23\ntally = 24\ntally = 25\ntally = 26\ntally = 27\ntally = 28\ntally = 29\ntally = 30\ntally = 31\ntally = 32\ntally = 33\ntally = 34\ntally = 35\ntally = 36\ntally = 37\ntally = 38\ntally = 39\ntally = 40\ntally = 41\ntally = 42\ntally = 43\ntally = 44\ntally = 45\ntally = 46\ntally = 47\ntally = 48\ntally = 49\ntally = 50\ntally = 51\ntally = 52\ntally = 53\ntally = 54\ntally = 55\ntally = 56\ntally = 57\ntally = 58\ntally = 59\ntally = 60\ntally = 61\ntally = 62\ntally = 63\ntally = 64\ntally = 65\ntally = 66\ntally = 67\ntally = 68\ntally = 69\ntally = 70\ntally = 71\ntally = 72\ntally = 73\ntally = 74\ntally = 75\ntally = 76\ntally = 77\ntally = 78\ntally = 79\ntally = 80\ntally = 81\ntally = hostValue\nlet one: integer = tally\nlet two: integer = tally\nrepeat tally {}\nsay \"DONE\"\nexit\n"],
];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  "commands": [
    [
      "node followups.mjs",
      "R/astra-m4-s8c-review-r2-evidence/worker/run-followups.sh:3"
    ]
  ],
  "sources": 3,
  "sha256": "77127bcb5cff95dca153577425df924ac0e394b929ea4d341066f7fefe86934e"
};
