// The s8-stores property family's sources (#1442), made from its dimensions
// (tests/families/property/) at profile focused, seed 1442; its run reads no other input. Plan:
// c3558387865dd01a0f57f4a1c6c3de98c68e39a7ce70f69396cbe6c3368d672d
export const cases = [
  [
    "s8-19a99765b5a5db21",
    'let origin: integer[][] = [[15]]\nlet target = origin\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-cae70895f849aaae",
    'let origin: boolean[] = [true]\nlet box = [origin]\nsay "BEFORE"\nbox[0] = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-5a3e069dd019ae78",
    'let origin: string[]? = ["text-14"]\nlet target = origin\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-be2d86691ffd9cd8",
    'let origin: boolean?[][] = [[true]]\nlet stage = origin\nlet target = stage\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-7009334e20357962",
    'let origin: string[][] = [["text-14"]]\nlet box = {payload: origin}\nsay "BEFORE"\nbox.payload = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-051bb7343ca98366",
    'let origin: integer[]? = [15]\nlet stage = origin\nlet target = stage\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-37acfa2b1dc3ed7a",
    'let origin: integer[]? = [15]\nlet box = {payload: origin}\nsay "BEFORE"\nbox.payload = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-f4dbd0f69164e7aa",
    'let origin: boolean?[][] = [[true]]\nlet box = {payload: origin}\nsay "BEFORE"\nbox.payload = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-790549a20d3d989e",
    'let origin: boolean?[][] = [[true]]\nlet box = [origin]\nsay "BEFORE"\nbox[0] = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-7c31c110df5bcd3e",
    'let origin: boolean[][] = [[true]]\nsay "BEFORE"\norigin = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-d999875b9a0696bc",
    'let origin: string[]? = ["text-14"]\nsay "BEFORE"\norigin = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-381d9887a04f1293",
    'let origin: string[] = ["text-14"]\nlet stage = origin\nlet target = stage\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-82f81d21a6a8ed25",
    'let origin: integer?[] = [15]\nsay "BEFORE"\norigin = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-1b98a6c284a6a4f4",
    'let origin: integer[][]? = [[15]]\nlet box = [origin]\nsay "BEFORE"\nbox[0] = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-c9216c1cba22451d",
    'let origin: boolean?[][] = [[true]]\nlet target = origin\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-e079e7b068e22719",
    'let origin: string?[] = ["text-14"]\nlet stage = origin\nlet target = stage\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-90daee7a4c1f682e",
    'let origin: integer[][]? = [[15]]\nlet stage = origin\nlet target = stage\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-814b7045a072c17d",
    'let origin: boolean?[] = [true]\nlet box = [origin]\nsay "BEFORE"\nbox[0] = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-b01d305a32dbe638",
    'let origin: string?[] = ["text-14"]\nlet box = {payload: origin}\nsay "BEFORE"\nbox.payload = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-12b661470ec693fa",
    'let origin: string?[][] = [["text-14"]]\nsay "BEFORE"\norigin = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-14c4b26f213d3194",
    'let origin: integer[][] = [[15]]\nlet stage = origin\nlet target = stage\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-c6658780b940bc51",
    'let origin: integer?[] = [15]\nlet target = origin\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-e0f57f2a93f11d84",
    'let origin: string[] = ["text-14"]\nlet box = {payload: origin}\nsay "BEFORE"\nbox.payload = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-c8c09d0822dc03e2",
    'let origin: string[] = ["text-14"]\nsay "BEFORE"\norigin = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-6dcdd8c09fa14af8",
    'let origin: string[][] = [["text-14"]]\nlet box = [origin]\nsay "BEFORE"\nbox[0] = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-8382d0c510883bcc",
    'let origin: string[]? = ["text-14"]\nlet box = [origin]\nsay "BEFORE"\nbox[0] = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-0468e9a3142baac8",
    'let origin: boolean[][]? = [[true]]\nsay "BEFORE"\norigin = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-b737382e2b0ab8af",
    'let origin: string[][]? = [["text-14"]]\nlet box = {payload: origin}\nsay "BEFORE"\nbox.payload = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-dff507d25f967a59",
    'let origin: integer[] = [15]\nlet target = origin\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-f8d205be932fcd9e",
    'let origin: string[][]? = [["text-14"]]\nlet target = origin\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-cebe8b07f6d0cc3a",
    'let origin: integer[]? = [15]\nlet target = origin\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-86d99531103c9ede",
    'let origin: string[] = ["text-14"]\nlet box = [origin]\nsay "BEFORE"\nbox[0] = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-ee23f7eb0ccac6f8",
    'let origin: string[][] = [["text-14"]]\nlet target = origin\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-01d62d958d0be002",
    'let origin: string?[][] = [["text-14"]]\nlet box = [origin]\nsay "BEFORE"\nbox[0] = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-83306144162b888e",
    'let origin: integer[][] = [[15]]\nsay "BEFORE"\norigin = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-1f175a1dd58fe21c",
    'let origin: boolean[][]? = [[true]]\nlet stage = origin\nlet target = stage\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-86d7d6defd600c97",
    'let origin: integer[] = [15]\nlet box = [origin]\nsay "BEFORE"\nbox[0] = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-c9625785d3139a9e",
    'let origin: boolean[][] = [[true]]\nlet target = origin\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-9d339c50c52f095c",
    'let origin: integer?[] = [15]\nlet box = [origin]\nsay "BEFORE"\nbox[0] = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-8f9a96245b875b1d",
    'let origin: integer[][] = [[15]]\nlet box = {payload: origin}\nsay "BEFORE"\nbox.payload = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-e465bd2c78b6f573",
    'let origin: boolean[]? = [true]\nlet box = {payload: origin}\nsay "BEFORE"\nbox.payload = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-936a0ca1bd9fbb23",
    'let origin: integer[] = [15]\nlet box = {payload: origin}\nsay "BEFORE"\nbox.payload = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-f5fb278e294ed65d",
    'let origin: string[]? = ["text-14"]\nlet box = {payload: origin}\nsay "BEFORE"\nbox.payload = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-4c448e63f89b5108",
    'let origin: boolean?[][] = [[true]]\nsay "BEFORE"\norigin = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-71789e1877b9de22",
    'let origin: boolean[]? = [true]\nlet stage = origin\nlet target = stage\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-2ac7c2a0cadd3bdf",
    'let origin: integer?[][] = [[15]]\nsay "BEFORE"\norigin = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-87c80c7350a45abf",
    'let origin: boolean?[] = [true]\nlet stage = origin\nlet target = stage\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-89a8c5dcaff2f218",
    'let origin: boolean[][]? = [[true]]\nlet box = [origin]\nsay "BEFORE"\nbox[0] = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-9c4f1702d4759291",
    'let origin: boolean?[] = [true]\nsay "BEFORE"\norigin = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-c63339e3d11e8288",
    'let origin: integer?[] = [15]\nlet box = {payload: origin}\nsay "BEFORE"\nbox.payload = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-495c68e95e34faef",
    'let origin: string?[] = ["text-14"]\nlet target = origin\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-4f6b6f66f529bd1e",
    'let origin: boolean[] = [true]\nlet box = {payload: origin}\nsay "BEFORE"\nbox.payload = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-086799cf1b549204",
    'let origin: boolean[] = [true]\nsay "BEFORE"\norigin = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-333bc1861c7bba92",
    'let origin: string?[] = ["text-14"]\nsay "BEFORE"\norigin = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-33f10c3ccdd40982",
    'let origin: integer[][] = [[15]]\nlet box = [origin]\nsay "BEFORE"\nbox[0] = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-63730b5a02cb9c9a",
    'let origin: boolean[]? = [true]\nlet target = origin\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-f850a941df5f4db8",
    'let origin: string[][]? = [["text-14"]]\nlet stage = origin\nlet target = stage\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-a3f034169b568ac7",
    'let origin: string?[][] = [["text-14"]]\nlet stage = origin\nlet target = stage\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-9ad0f845edc1a611",
    'let origin: string?[][] = [["text-14"]]\nlet target = origin\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-264cd3d043644a5c",
    'let origin: boolean?[] = [true]\nlet box = {payload: origin}\nsay "BEFORE"\nbox.payload = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-9463eed138b057b6",
    'let origin: integer?[][] = [[15]]\nlet stage = origin\nlet target = stage\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-64d4911c367c262b",
    'let origin: boolean?[] = [true]\nlet target = origin\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-b9aff501c1efb7e5",
    'let origin: integer?[][] = [[15]]\nlet box = {payload: origin}\nsay "BEFORE"\nbox.payload = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-2e07f6251ef8de07",
    'let origin: integer[] = [15]\nsay "BEFORE"\norigin = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-206c7032b78aff42",
    'let origin: boolean[][] = [[true]]\nlet box = {payload: origin}\nsay "BEFORE"\nbox.payload = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-a2cf23e383037322",
    'let origin: boolean[][] = [[true]]\nlet stage = origin\nlet target = stage\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-5a4c2cb647afb902",
    'let origin: string[][]? = [["text-14"]]\nlet box = [origin]\nsay "BEFORE"\nbox[0] = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-ce495e95f0483f95",
    'let origin: integer[]? = [15]\nlet box = [origin]\nsay "BEFORE"\nbox[0] = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-30a86ac51d580711",
    'let origin: integer[] = [15]\nlet stage = origin\nlet target = stage\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-3470639c92660b88",
    'let origin: string[]? = ["text-14"]\nlet stage = origin\nlet target = stage\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-6ebe4474f32ff09d",
    'let origin: boolean[]? = [true]\nsay "BEFORE"\norigin = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-f6a8e678e0919c4a",
    'let origin: boolean[] = [true]\nlet stage = origin\nlet target = stage\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-1eefd7e7d6ba97d6",
    'let origin: integer?[] = [15]\nlet stage = origin\nlet target = stage\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-e643ca4f1ba3e2bd",
    'let origin: boolean[]? = [true]\nlet box = [origin]\nsay "BEFORE"\nbox[0] = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-8db322dbad37965a",
    'let origin: string[][] = [["text-14"]]\nsay "BEFORE"\norigin = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-29179232d31c841f",
    'let origin: string[] = ["text-14"]\nlet target = origin\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-155fa04f510ee2c7",
    'let origin: string?[][] = [["text-14"]]\nlet box = {payload: origin}\nsay "BEFORE"\nbox.payload = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-df4a5bd7f83b6662",
    'let origin: string[][] = [["text-14"]]\nlet stage = origin\nlet target = stage\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-6ebc2a1c75d2b9d7",
    'let origin: integer?[][] = [[15]]\nlet box = [origin]\nsay "BEFORE"\nbox[0] = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-c45ffc8594a1689f",
    'let origin: boolean[][]? = [[true]]\nlet box = {payload: origin}\nsay "BEFORE"\nbox.payload = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-4ef86539d3d1f918",
    'let origin: boolean[][] = [[true]]\nlet box = [origin]\nsay "BEFORE"\nbox[0] = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-4759b99d6dcb2a12",
    'let origin: integer?[][] = [[15]]\nlet target = origin\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-77c30fb5ff2e69fc",
    'let origin: string?[] = ["text-14"]\nlet box = [origin]\nsay "BEFORE"\nbox[0] = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-af9b59d81e83989d",
    'let origin: integer[][]? = [[15]]\nlet box = {payload: origin}\nsay "BEFORE"\nbox.payload = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-50bbf3eb75695f6c",
    'let origin: integer[]? = [15]\nsay "BEFORE"\norigin = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-4730951d5f3e5135",
    'let origin: boolean[] = [true]\nlet target = origin\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-f5b4863c8046f670",
    'let origin: string[][]? = [["text-14"]]\nsay "BEFORE"\norigin = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-399e23dcfaef178c",
    'let origin: integer[][]? = [[15]]\nsay "BEFORE"\norigin = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-596830a13ee5c77c",
    'let origin: boolean[][]? = [[true]]\nlet target = origin\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
  ],
  [
    "s8-7201fe77a36ddea5",
    'let origin: integer[][]? = [[15]]\nlet target = origin\nsay "BEFORE"\ntarget = hostValue\nsay "AFTER"\nexit\n',
  ],
];
export const globals = ["hostValue"];
export const checks = ["publication", "stops"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node tests/families/property/bin/pilot.mjs plan --family s8-stores --profile focused --seed 1442 --out <plan>; bin/pilot.mjs run --plan <plan> --build <tree> per tree",
      "desktop:~/work/evidence/corpus/tooling/property-families/property-family-pilot/evidence/focused-post/plan.json, README.md",
    ],
  ],
  sources: 90,
  sha256: "8c0e9c16f483f49219eef38048af922113f31a938676d59e728760d399c6765a",
};
