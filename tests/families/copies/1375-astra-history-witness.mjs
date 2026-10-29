export const cases = [
  [
    "original-1",
    "let a = {q: [{inner: {n: 1}}]}\nlet b = {q: [{inner: {n: 2}}]}\nlet c = {elsewhere: {missing: {n: 3}}}\nexit\n",
  ],
  [
    "original-2",
    "let r0 = {n: 0}\nlet r1 = {n: 1}\nlet r2 = {n: 2}\nlet r3 = {n: 3}\nlet r4 = {n: 4}\nlet r5 = {n: 5}\nlet r6 = {n: 6}\nlet r7 = {n: 7}\nlet r8 = {n: 8}\nlet r9 = {n: 9}\nlet r10 = {n: 10}\nlet r11 = {n: 11}\nlet box = {q: {deep: [r0,r1,r2,r3,r4,r5,r6,r7,r8,r9,r10,r11]}}\nsay box.q.deep[0].n\nexit\n",
  ],
];

export const checks = ["publication"];
