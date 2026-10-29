// #1165 / S8; Astra review.
export const cases = (() => {
  const cases = {
    B1: 'let n = 1\nn = "wrong"\nsay "AFTER"\nexit\n',
    B2: 'let base: integer[]? = hostValue\nlet copy = base\nsay copy.length\nsay "AFTER"\nexit\n',
    B3: 'let flag: boolean = hostValue\nlet room = {n: 1}\nroom = {n: 1}\nif flag { room = {other: 0} }\nsay room.n\nsay room.n\nsay "DONE"\nexit\n',
  };
  return Object.entries(cases);
})();
export const checks = ["publication", "stops"];
