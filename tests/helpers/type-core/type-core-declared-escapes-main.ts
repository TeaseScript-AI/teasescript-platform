// `MAIN` is main's side: recorded at 664f1183f by lane 2b's recorder (`probe33.mjs` in #2116's evidence), per source and
// mode, the natural plan's and answers' digests and, at each edge, main's stop state, its `typeCheck` count, its plan's
// digest, its stopped decisions (a digest outside a window, the list inside a settled one) and, in a settled window, its
// runs' digest over the stop oracle's host values and its answers that differ from the natural ones. A change that
// moves a recorded value re-records it with its ground here: the source, mode and allowance that moved, how, and the
// change that moved it (docs/TESTING.md, "Pinned work").
// - 664f1183f, every value re-recorded: #2216 lists a completion's check by its store's own records, so the plan and
//   runs digests are raw, no longer with properties sorted and the named property masked (ruling 12 (5)). Every edge's
//   stop state, `typeCheck` count, stopped decisions and answers, every window and the natural answers equal the record
//   at efbd7fdee, made before #2203's gate.

/** Main's stop state at an allowance: settled, or stopped unsettled in admission. */
type MainState = "settled" | "admission";

/**
 * Main's side per source and held mode: the natural plan's digest and the natural answers' digest; the measured windows,
 * `[kind, lo, hi)`; and at each window's edges (`lo - 1`, `lo`, `hi - 1`, `hi`) main's stop state, `typeCheck` count and
 * plan digest; outside a window, the digest of its stopped decisions (`place|path`, sorted); in a settled window, its runs
 * digest, its stopped decisions and each occurrence answer that differs from the natural one (`index=tag:cert:reasons`).
 */
export const MAIN: Readonly<
  Record<
    string,
    readonly {
      readonly natural: string;
      readonly naturalAnswers: string;
      readonly windows: readonly (readonly [
        "adverse" | "favourable" | "settled",
        number,
        number,
      ])[];
      readonly at: Readonly<
        Record<
          number,
          readonly [
            MainState,
            number,
            string,
            string | null,
            string | readonly string[] | null,
            string | null,
          ]
        >
      >;
    }[]
  >
> = {
  "direct-distinct-whole-8": [
    {
      natural: "800ba00b6c777d1d",
      naturalAnswers: "a3549cf84d6f2af8",
      windows: [
        ["adverse", 74, 91],
        ["adverse", 94, 106],
        ["adverse", 109, 121],
        ["adverse", 124, 136],
        ["adverse", 139, 151],
        ["adverse", 154, 166],
      ],
      at: {
        73: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
        74: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        90: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        91: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
        93: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
        94: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        105: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        106: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
        108: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
        109: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        120: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        121: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
        123: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
        124: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        135: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        136: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
        138: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
        139: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        150: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        151: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
        153: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
        154: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        165: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        166: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
      },
    },
    { natural: "800ba00b6c777d1d", naturalAnswers: "a3549cf84d6f2af8", windows: [], at: {} },
    {
      natural: "800ba00b6c777d1d",
      naturalAnswers: "a3549cf84d6f2af8",
      windows: [
        ["adverse", 74, 91],
        ["adverse", 94, 106],
        ["adverse", 109, 121],
        ["adverse", 201, 276],
      ],
      at: {
        73: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
        74: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        90: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        91: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
        93: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
        94: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        105: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        106: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
        108: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
        109: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        120: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        121: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
        200: ["admission", 0, "1cba611a9289e04b", null, "e3b0c44298fc1c14", null],
        201: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        275: ["settled", 1, "800ba00b6c777d1d", null, null, null],
        276: ["settled", 1, "800ba00b6c777d1d", null, "e3b0c44298fc1c14", null],
      },
    },
    { natural: "800ba00b6c777d1d", naturalAnswers: "a3549cf84d6f2af8", windows: [], at: {} },
  ],
  "copy-every-whole-4": [
    {
      natural: "56020da3a9c542ae",
      naturalAnswers: "96bfae7d16bbe24e",
      windows: [["adverse", 379, 408]],
      at: {
        378: ["admission", 0, "52ca0a26c47a4735", null, "e3b0c44298fc1c14", null],
        379: ["settled", 1, "56020da3a9c542ae", null, null, null],
        407: ["settled", 1, "56020da3a9c542ae", null, null, null],
        408: ["settled", 1, "56020da3a9c542ae", null, "e3b0c44298fc1c14", null],
      },
    },
    {
      natural: "56020da3a9c542ae",
      naturalAnswers: "96bfae7d16bbe24e",
      windows: [["favourable", 449, 450]],
      at: {
        448: ["settled", 1, "56020da3a9c542ae", null, "0171c85b4d4cad86", null],
        449: ["admission", 0, "52ca0a26c47a4735", null, null, null],
        450: ["admission", 0, "52ca0a26c47a4735", null, "e3b0c44298fc1c14", null],
      },
    },
    {
      natural: "56020da3a9c542ae",
      naturalAnswers: "96bfae7d16bbe24e",
      windows: [
        ["adverse", 303, 337],
        ["settled", 337, 338],
        ["adverse", 338, 369],
      ],
      at: {
        302: ["admission", 0, "52ca0a26c47a4735", null, "e3b0c44298fc1c14", null],
        303: ["settled", 1, "56020da3a9c542ae", null, null, null],
        336: ["settled", 1, "56020da3a9c542ae", null, null, null],
        337: ["settled", 1, "56020da3a9c542ae", "1bbef63e9f21c6c0", [], ""],
        338: ["settled", 1, "56020da3a9c542ae", null, null, null],
        368: ["settled", 1, "56020da3a9c542ae", null, null, null],
        369: ["settled", 1, "56020da3a9c542ae", null, "e3b0c44298fc1c14", null],
      },
    },
    {
      natural: "56020da3a9c542ae",
      naturalAnswers: "96bfae7d16bbe24e",
      windows: [
        ["adverse", 335, 369],
        ["favourable", 379, 380],
      ],
      at: {
        334: ["admission", 0, "52ca0a26c47a4735", null, "e3b0c44298fc1c14", null],
        335: ["settled", 1, "56020da3a9c542ae", null, null, null],
        368: ["settled", 1, "56020da3a9c542ae", null, null, null],
        369: ["settled", 1, "56020da3a9c542ae", null, "0171c85b4d4cad86", null],
        378: ["settled", 1, "56020da3a9c542ae", null, "0171c85b4d4cad86", null],
        379: ["admission", 0, "52ca0a26c47a4735", null, null, null],
        380: ["admission", 0, "52ca0a26c47a4735", null, "e3b0c44298fc1c14", null],
      },
    },
  ],
  "direct-distinct-field-4": [
    {
      natural: "012be07dc9275048",
      naturalAnswers: "7427e01266df74fe",
      windows: [
        ["settled", 63, 65],
        ["adverse", 65, 67],
        ["settled", 72, 73],
        ["settled", 74, 75],
        ["settled", 77, 78],
        ["settled", 79, 80],
        ["adverse", 84, 86],
        ["favourable", 92, 94],
        ["adverse", 95, 109],
      ],
      at: {
        62: ["settled", 1, "012be07dc9275048", null, "b16928a7c7325332", null],
        63: [
          "settled",
          1,
          "012be07dc9275048",
          "b9985386ba67536d",
          [
            "18|f0",
            "18|f0.n",
            "18|f1",
            "18|f1.n",
            "18|f2",
            "18|f2.n",
            "18|f3",
            "18|f3.n",
            "39|",
            "47|",
            "51|",
            "63|",
            "67|",
            "9|f1",
            "9|f1.n",
            "9|g",
          ],
          "21=unknown:pos:16 22=unknown:pos:16 24=unknown:pos:16 25=unknown:pos:16 27=unknown:pos:16 28=unknown:pos:16 30=unknown:pos:16 31=unknown:pos:16 33=unknown:pos:16 34=unknown:pos:16 36=unknown:pos:16 37=unknown:pos:16 39=unknown:pos:16 40=unknown:pos:16 42=unknown:pos:16 43=unknown:pos:16",
        ],
        64: [
          "settled",
          1,
          "012be07dc9275048",
          "b9985386ba67536d",
          [
            "18|f0",
            "18|f0.n",
            "18|f1",
            "18|f1.n",
            "18|f2",
            "18|f2.n",
            "18|f3",
            "18|f3.n",
            "47|",
            "51|",
            "63|",
            "67|",
            "9|f1",
            "9|f1.n",
            "9|g",
          ],
          "21=unknown:pos:16 22=unknown:pos:16 24=unknown:pos:16 25=unknown:pos:16 27=unknown:pos:16 28=unknown:pos:16 30=unknown:pos:16 31=unknown:pos:16 33=unknown:pos:16 34=unknown:pos:16 36=unknown:pos:16 37=unknown:pos:16 39=unknown:pos:16 40=unknown:pos:16 42=unknown:pos:16 43=unknown:pos:16",
        ],
        65: ["settled", 1, "012be07dc9275048", null, null, null],
        66: ["settled", 1, "012be07dc9275048", null, null, null],
        67: ["settled", 1, "012be07dc9275048", null, "dc977104d4c2cbc5", null],
        71: ["settled", 1, "012be07dc9275048", null, "dc977104d4c2cbc5", null],
        72: [
          "settled",
          1,
          "012be07dc9275048",
          "b9985386ba67536d",
          [
            "18|f1",
            "18|f1.n",
            "18|f2",
            "18|f2.n",
            "18|f3",
            "18|f3.n",
            "47|",
            "51|",
            "67|",
            "9|f1",
            "9|f1.n",
            "9|g",
          ],
          "24=unknown:pos:16 25=unknown:pos:16 27=unknown:pos:16 28=unknown:pos:16 30=unknown:pos:16 31=unknown:pos:16 36=unknown:pos:16 37=unknown:pos:16 39=unknown:pos:16 40=unknown:pos:16 42=unknown:pos:16 43=unknown:pos:16",
        ],
        73: ["settled", 1, "012be07dc9275048", null, "05eccc36100636d6", null],
        74: [
          "settled",
          1,
          "012be07dc9275048",
          "b9985386ba67536d",
          [
            "18|f1",
            "18|f1.n",
            "18|f2",
            "18|f2.n",
            "18|f3",
            "18|f3.n",
            "51|",
            "67|",
            "9|f1",
            "9|f1.n",
            "9|g",
          ],
          "24=unknown:pos:16 25=unknown:pos:16 27=unknown:pos:16 28=unknown:pos:16 30=unknown:pos:16 31=unknown:pos:16 36=unknown:pos:16 37=unknown:pos:16 39=unknown:pos:16 40=unknown:pos:16 42=unknown:pos:16 43=unknown:pos:16",
        ],
        75: ["settled", 1, "012be07dc9275048", null, "a5520c5577baef31", null],
        76: ["settled", 1, "012be07dc9275048", null, "a5520c5577baef31", null],
        77: [
          "settled",
          1,
          "012be07dc9275048",
          "b9985386ba67536d",
          [
            "18|f1",
            "18|f1.n",
            "18|f2",
            "18|f2.n",
            "18|f3",
            "18|f3.n",
            "51|",
            "9|f1",
            "9|f1.n",
            "9|g",
          ],
          "24=unknown:pos:16 25=unknown:pos:16 27=unknown:pos:16 28=unknown:pos:16 30=unknown:pos:16 31=unknown:pos:16 36=unknown:pos:16 37=unknown:pos:16 39=unknown:pos:16 40=unknown:pos:16 42=unknown:pos:16 43=unknown:pos:16",
        ],
        78: ["settled", 1, "012be07dc9275048", null, "5108870af1245c70", null],
        79: [
          "settled",
          1,
          "012be07dc9275048",
          "b9985386ba67536d",
          ["18|f1", "18|f1.n", "18|f2", "18|f2.n", "18|f3", "18|f3.n", "9|f1", "9|f1.n", "9|g"],
          "24=unknown:pos:16 25=unknown:pos:16 27=unknown:pos:16 28=unknown:pos:16 30=unknown:pos:16 31=unknown:pos:16 36=unknown:pos:16 37=unknown:pos:16 39=unknown:pos:16 40=unknown:pos:16 42=unknown:pos:16 43=unknown:pos:16",
        ],
        80: ["settled", 1, "012be07dc9275048", null, "eb16d6079f46fb9f", null],
        83: ["admission", 0, "831851b9fa2b83fa", null, "e3b0c44298fc1c14", null],
        84: ["settled", 1, "012be07dc9275048", null, null, null],
        85: ["settled", 1, "012be07dc9275048", null, null, null],
        86: ["settled", 1, "012be07dc9275048", null, "ab8a912f43f210da", null],
        91: ["settled", 1, "012be07dc9275048", null, "ab8a912f43f210da", null],
        92: ["admission", 0, "831851b9fa2b83fa", null, null, null],
        93: ["admission", 0, "831851b9fa2b83fa", null, null, null],
        94: ["admission", 0, "831851b9fa2b83fa", null, "e3b0c44298fc1c14", null],
        95: ["settled", 1, "012be07dc9275048", null, null, null],
        108: ["settled", 1, "012be07dc9275048", null, null, null],
        109: ["settled", 1, "012be07dc9275048", null, "a2c2a4307be628df", null],
      },
    },
    { natural: "012be07dc9275048", naturalAnswers: "7427e01266df74fe", windows: [], at: {} },
    {
      natural: "012be07dc9275048",
      naturalAnswers: "7427e01266df74fe",
      windows: [
        ["settled", 44, 45],
        ["settled", 46, 47],
        ["settled", 49, 50],
        ["settled", 51, 52],
        ["settled", 59, 63],
        ["adverse", 65, 67],
        ["adverse", 84, 86],
        ["favourable", 92, 94],
        ["adverse", 95, 109],
      ],
      at: {
        43: ["settled", 1, "012be07dc9275048", null, "7324ffe6f219521c", null],
        44: [
          "settled",
          1,
          "012be07dc9275048",
          "b9985386ba67536d",
          [
            "18|f0",
            "18|f0.n",
            "18|f1",
            "18|f1.n",
            "18|f2",
            "18|f2.n",
            "18|f3",
            "18|f3.n",
            "47|",
            "51|",
            "67|",
            "9|f1",
            "9|f1.n",
            "9|g",
          ],
          "21=unknown:pos:16 22=unknown:pos:16 24=unknown:pos:16 25=unknown:pos:16 27=unknown:pos:16 28=unknown:pos:16 30=unknown:pos:16 31=unknown:pos:16 33=unknown:pos:16 34=unknown:pos:16 36=unknown:pos:16 37=unknown:pos:16 39=unknown:pos:16 40=unknown:pos:16 42=unknown:pos:16 43=unknown:pos:16",
        ],
        45: ["settled", 1, "012be07dc9275048", null, "8d48a2d1794dd883", null],
        46: [
          "settled",
          1,
          "012be07dc9275048",
          "b9985386ba67536d",
          [
            "18|f0",
            "18|f0.n",
            "18|f1",
            "18|f1.n",
            "18|f2",
            "18|f2.n",
            "18|f3",
            "18|f3.n",
            "51|",
            "67|",
            "9|f1",
            "9|f1.n",
            "9|g",
          ],
          "21=unknown:pos:16 22=unknown:pos:16 24=unknown:pos:16 25=unknown:pos:16 27=unknown:pos:16 28=unknown:pos:16 30=unknown:pos:16 31=unknown:pos:16 33=unknown:pos:16 34=unknown:pos:16 36=unknown:pos:16 37=unknown:pos:16 39=unknown:pos:16 40=unknown:pos:16 42=unknown:pos:16 43=unknown:pos:16",
        ],
        47: ["settled", 1, "012be07dc9275048", null, "5c93115f87996d1d", null],
        48: ["settled", 1, "012be07dc9275048", null, "5c93115f87996d1d", null],
        49: [
          "settled",
          1,
          "012be07dc9275048",
          "b9985386ba67536d",
          [
            "18|f0",
            "18|f0.n",
            "18|f1",
            "18|f1.n",
            "18|f2",
            "18|f2.n",
            "18|f3",
            "18|f3.n",
            "51|",
            "9|f1",
            "9|f1.n",
            "9|g",
          ],
          "21=unknown:pos:16 22=unknown:pos:16 24=unknown:pos:16 25=unknown:pos:16 27=unknown:pos:16 28=unknown:pos:16 30=unknown:pos:16 31=unknown:pos:16 33=unknown:pos:16 34=unknown:pos:16 36=unknown:pos:16 37=unknown:pos:16 39=unknown:pos:16 40=unknown:pos:16 42=unknown:pos:16 43=unknown:pos:16",
        ],
        50: ["settled", 1, "012be07dc9275048", null, "d2c9db517c57f840", null],
        51: [
          "settled",
          1,
          "012be07dc9275048",
          "b9985386ba67536d",
          [
            "18|f0",
            "18|f0.n",
            "18|f1",
            "18|f1.n",
            "18|f2",
            "18|f2.n",
            "18|f3",
            "18|f3.n",
            "9|f1",
            "9|f1.n",
            "9|g",
          ],
          "21=unknown:pos:16 22=unknown:pos:16 24=unknown:pos:16 25=unknown:pos:16 27=unknown:pos:16 28=unknown:pos:16 30=unknown:pos:16 31=unknown:pos:16 33=unknown:pos:16 34=unknown:pos:16 36=unknown:pos:16 37=unknown:pos:16 39=unknown:pos:16 40=unknown:pos:16 42=unknown:pos:16 43=unknown:pos:16",
        ],
        52: ["settled", 1, "012be07dc9275048", null, "8c401171009c364f", null],
        58: ["settled", 1, "012be07dc9275048", null, "8c401171009c364f", null],
        59: [
          "settled",
          1,
          "012be07dc9275048",
          "b9985386ba67536d",
          [
            "18|f0",
            "18|f0.n",
            "18|f1",
            "18|f1.n",
            "18|f2",
            "18|f2.n",
            "18|f3",
            "18|f3.n",
            "9|f1",
            "9|f1.n",
            "9|g",
          ],
          "21=unknown:pos:16 22=unknown:pos:16 24=unknown:pos:16 25=unknown:pos:16 27=unknown:pos:16 28=unknown:pos:16 30=unknown:pos:16 31=unknown:pos:16 33=unknown:pos:16 34=unknown:pos:16 36=unknown:pos:16 37=unknown:pos:16 39=unknown:pos:16 40=unknown:pos:16 42=unknown:pos:16 43=unknown:pos:16",
        ],
        62: [
          "settled",
          1,
          "012be07dc9275048",
          "b9985386ba67536d",
          [
            "18|f0",
            "18|f0.n",
            "18|f1",
            "18|f1.n",
            "18|f2",
            "18|f2.n",
            "18|f3",
            "18|f3.n",
            "9|f1",
            "9|f1.n",
            "9|g",
          ],
          "21=unknown:pos:16 22=unknown:pos:16 24=unknown:pos:16 25=unknown:pos:16 27=unknown:pos:16 28=unknown:pos:16 30=unknown:pos:16 31=unknown:pos:16 33=unknown:pos:16 34=unknown:pos:16 36=unknown:pos:16 37=unknown:pos:16 39=unknown:pos:16 40=unknown:pos:16 42=unknown:pos:16 43=unknown:pos:16",
        ],
        63: ["settled", 1, "012be07dc9275048", null, "8c401171009c364f", null],
        64: ["settled", 1, "012be07dc9275048", null, "8c401171009c364f", null],
        65: ["settled", 1, "012be07dc9275048", null, null, null],
        66: ["settled", 1, "012be07dc9275048", null, null, null],
        67: ["settled", 1, "012be07dc9275048", null, "eb16d6079f46fb9f", null],
        83: ["admission", 0, "831851b9fa2b83fa", null, "e3b0c44298fc1c14", null],
        84: ["settled", 1, "012be07dc9275048", null, null, null],
        85: ["settled", 1, "012be07dc9275048", null, null, null],
        86: ["settled", 1, "012be07dc9275048", null, "ab8a912f43f210da", null],
        91: ["settled", 1, "012be07dc9275048", null, "ab8a912f43f210da", null],
        92: ["admission", 0, "831851b9fa2b83fa", null, null, null],
        93: ["admission", 0, "831851b9fa2b83fa", null, null, null],
        94: ["admission", 0, "831851b9fa2b83fa", null, "e3b0c44298fc1c14", null],
        95: ["settled", 1, "012be07dc9275048", null, null, null],
        108: ["settled", 1, "012be07dc9275048", null, null, null],
        109: ["settled", 1, "012be07dc9275048", null, "a2c2a4307be628df", null],
      },
    },
    {
      natural: "012be07dc9275048",
      naturalAnswers: "7427e01266df74fe",
      windows: [["settled", 44, 53]],
      at: {
        43: ["settled", 1, "012be07dc9275048", null, "7324ffe6f219521c", null],
        44: [
          "settled",
          1,
          "012be07dc9275048",
          "b9985386ba67536d",
          [
            "18|f0",
            "18|f0.n",
            "18|f1",
            "18|f1.n",
            "18|f2",
            "18|f2.n",
            "18|f3",
            "18|f3.n",
            "51|",
            "63|",
            "67|",
            "9|f1",
            "9|f1.n",
            "9|g",
          ],
          "21=unknown:pos:16 22=unknown:pos:16 24=unknown:pos:16 25=unknown:pos:16 27=unknown:pos:16 28=unknown:pos:16 30=unknown:pos:16 31=unknown:pos:16 33=unknown:pos:16 34=unknown:pos:16 36=unknown:pos:16 37=unknown:pos:16 39=unknown:pos:16 40=unknown:pos:16 42=unknown:pos:16 43=unknown:pos:16",
        ],
        52: [
          "settled",
          1,
          "012be07dc9275048",
          "b9985386ba67536d",
          [
            "18|f0",
            "18|f0.n",
            "18|f1",
            "18|f1.n",
            "18|f2",
            "18|f2.n",
            "18|f3",
            "18|f3.n",
            "9|f1",
            "9|f1.n",
            "9|g",
          ],
          "21=unknown:pos:16 22=unknown:pos:16 24=unknown:pos:16 25=unknown:pos:16 27=unknown:pos:16 28=unknown:pos:16 30=unknown:pos:16 31=unknown:pos:16 33=unknown:pos:16 34=unknown:pos:16 36=unknown:pos:16 37=unknown:pos:16 39=unknown:pos:16 40=unknown:pos:16 42=unknown:pos:16 43=unknown:pos:16",
        ],
        53: ["admission", 0, "831851b9fa2b83fa", null, "e3b0c44298fc1c14", null],
      },
    },
  ],
  "two-whole-copies-five-settled": [
    {
      natural: "656e979f7285fa0e",
      naturalAnswers: "a457f7ca5528620c",
      windows: [["favourable", 48, 49]],
      at: {
        47: ["settled", 1, "656e979f7285fa0e", null, "4cb63cdff2f4eda3", null],
        48: ["admission", 0, "9f0fb9063726c25e", null, null, null],
        49: ["admission", 0, "9f0fb9063726c25e", null, "e3b0c44298fc1c14", null],
      },
    },
    {
      natural: "656e979f7285fa0e",
      naturalAnswers: "a457f7ca5528620c",
      windows: [["adverse", 44, 54]],
      at: {
        43: ["settled", 1, "656e979f7285fa0e", null, "4cb63cdff2f4eda3", null],
        44: ["settled", 1, "656e979f7285fa0e", null, null, null],
        53: ["settled", 1, "656e979f7285fa0e", null, null, null],
        54: ["admission", 0, "9f0fb9063726c25e", null, "e3b0c44298fc1c14", null],
      },
    },
    {
      natural: "656e979f7285fa0e",
      naturalAnswers: "a457f7ca5528620c",
      windows: [
        ["favourable", 68, 70],
        ["adverse", 71, 73],
        ["favourable", 76, 77],
        ["adverse", 334, 341],
      ],
      at: {
        67: ["settled", 1, "656e979f7285fa0e", null, "4cb63cdff2f4eda3", null],
        68: ["admission", 0, "9f0fb9063726c25e", null, null, null],
        69: ["admission", 0, "9f0fb9063726c25e", null, null, null],
        70: ["admission", 0, "9f0fb9063726c25e", null, "e3b0c44298fc1c14", null],
        71: ["settled", 1, "656e979f7285fa0e", null, null, null],
        72: ["settled", 1, "656e979f7285fa0e", null, null, null],
        73: ["settled", 1, "656e979f7285fa0e", null, "d746ce95202cf0a7", null],
        75: ["settled", 1, "656e979f7285fa0e", null, "d746ce95202cf0a7", null],
        76: ["admission", 0, "9f0fb9063726c25e", null, null, null],
        77: ["admission", 0, "9f0fb9063726c25e", null, "e3b0c44298fc1c14", null],
        333: ["admission", 0, "9f0fb9063726c25e", null, "e3b0c44298fc1c14", null],
        334: ["settled", 1, "656e979f7285fa0e", null, null, null],
        340: ["settled", 1, "656e979f7285fa0e", null, null, null],
        341: ["settled", 1, "656e979f7285fa0e", null, "e3b0c44298fc1c14", null],
      },
    },
    {
      natural: "656e979f7285fa0e",
      naturalAnswers: "a457f7ca5528620c",
      windows: [
        ["adverse", 43, 53],
        ["adverse", 336, 337],
      ],
      at: {
        42: ["admission", 0, "9f0fb9063726c25e", null, "e3b0c44298fc1c14", null],
        43: ["settled", 1, "656e979f7285fa0e", null, null, null],
        52: ["settled", 1, "656e979f7285fa0e", null, null, null],
        53: ["admission", 0, "9f0fb9063726c25e", null, "e3b0c44298fc1c14", null],
        335: ["admission", 0, "9f0fb9063726c25e", null, "e3b0c44298fc1c14", null],
        336: ["settled", 1, "656e979f7285fa0e", null, null, null],
        337: ["settled", 1, "656e979f7285fa0e", null, "e3b0c44298fc1c14", null],
      },
    },
  ],
};

/**
 * Main's side of the first-asker sources, each in its held mode: the natural plan's runs and, at each allowance of its
 * window (298 to 303 in mode 2, 243 to 250 with `f1` last, in mode 3) where both trees settle, whether main publishes,
 * with its runs, or refuses, with its reason. Each run is its outcome, code and span (`status code start:end`), then
 * what it said (`said …`), over `FIRST_ASKER_HOSTS`. Recorded at 5a1461a1c by lane 2b's recorders (`probe42.mjs`,
 * `probe43.mjs` in #2116's evidence), with each run's output since ruling 20; it is re-recorded as the file header says. Every natural run of the first two fails (a value that fits meets TSR017:
 * `root` holds no `f1` at the last store), so only the `f1`-last pair can show a published plan passing what the natural
 * run rejects.
 */
export const FIRST_ASKER_MAIN: Readonly<
  Record<
    string,
    {
      readonly mode: number;
      readonly natural: string;
      readonly at: Readonly<Record<number, readonly ["published" | "refused", string]>>;
    }
  >
> = {
  "first-asker-field-9": {
    mode: 2,
    natural:
      "failed TSR017 759:766; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796",
    at: {
      299: [
        "published",
        "failed TSR017 759:766; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796",
      ],
      300: [
        "published",
        "failed TSR017 759:766; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796",
      ],
      301: [
        "published",
        "failed TSR017 759:766; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796",
      ],
      302: [
        "published",
        "failed TSR017 759:766; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796",
      ],
      303: [
        "published",
        "failed TSR017 759:766; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796",
      ],
    },
  },
  "first-asker-field-9-n-host": {
    mode: 2,
    natural:
      "failed TSR058 767:780; failed TSR058 767:780; failed TSR058 767:780; failed TSR058 767:780; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR058 767:780; failed TSR058 767:780",
    at: {
      299: [
        "published",
        "failed TSR058 767:780; failed TSR058 767:780; failed TSR058 767:780; failed TSR058 767:780; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR058 767:780; failed TSR058 767:780",
      ],
      300: [
        "published",
        "failed TSR058 767:780; failed TSR058 767:780; failed TSR058 767:780; failed TSR058 767:780; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR058 767:780; failed TSR058 767:780",
      ],
      301: [
        "published",
        "failed TSR058 767:780; failed TSR058 767:780; failed TSR058 767:780; failed TSR058 767:780; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR058 767:780; failed TSR058 767:780",
      ],
      302: [
        "published",
        "failed TSR058 767:780; failed TSR058 767:780; failed TSR058 767:780; failed TSR058 767:780; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR058 767:780; failed TSR058 767:780",
      ],
      303: [
        "published",
        "failed TSR058 767:780; failed TSR058 767:780; failed TSR058 767:780; failed TSR058 767:780; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR017 759:766; failed TSR058 767:780; failed TSR058 767:780",
      ],
    },
  },
  "first-asker-field-9-f1-last": {
    mode: 3,
    natural:
      "halted said accepted; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796",
    at: {
      244: [
        "published",
        "halted said accepted; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796",
      ],
      245: [
        "published",
        "halted said accepted; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796",
      ],
      246: [
        "published",
        "halted said accepted; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796",
      ],
      247: [
        "published",
        "halted said accepted; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796",
      ],
      248: [
        "published",
        "halted said accepted; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796",
      ],
      249: [
        "published",
        "halted said accepted; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796",
      ],
      250: [
        "published",
        "halted said accepted; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796; failed TSR058 767:796",
      ],
    },
  },
  "first-asker-field-9-f1-last-n-host": {
    mode: 3,
    natural:
      "failed TSR058 767:780; failed TSR058 767:780; failed TSR058 767:780; failed TSR058 767:780; halted said accepted; halted said accepted; halted said accepted; halted said accepted; halted said accepted; halted said accepted; halted said accepted; halted said accepted; halted said accepted; failed TSR058 767:780; failed TSR058 767:780",
    at: {
      244: [
        "refused",
        "The candidate type analysis does not cover a store whose check was lost at the budget yet (main.tease, offset 767).",
      ],
      245: [
        "refused",
        "The candidate type analysis does not cover a store whose check was lost at the budget yet (main.tease, offset 767).",
      ],
      246: [
        "refused",
        "The candidate type analysis does not cover a store whose check was lost at the budget yet (main.tease, offset 767).",
      ],
      247: [
        "refused",
        "The candidate type analysis does not cover a store whose check was lost at the budget yet (main.tease, offset 767).",
      ],
      248: [
        "refused",
        "The candidate type analysis does not cover a store whose check was lost at the budget yet (main.tease, offset 767).",
      ],
      249: [
        "refused",
        "The candidate type analysis does not cover a store whose check was lost at the budget yet (main.tease, offset 767).",
      ],
      250: [
        "published",
        "failed TSR058 767:780; failed TSR058 767:780; failed TSR058 767:780; failed TSR058 767:780; halted said accepted; halted said accepted; halted said accepted; halted said accepted; halted said accepted; halted said accepted; halted said accepted; halted said accepted; halted said accepted; failed TSR058 767:780; failed TSR058 767:780",
      ],
    },
  },
};
