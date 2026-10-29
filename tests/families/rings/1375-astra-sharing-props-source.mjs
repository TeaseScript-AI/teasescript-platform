// #1375 Astra review r1.
export const cases = (() => {
  const source =
    'let item = {v0: 1}\nif askBoolean("Fraction?") { item.v0 = 1.5 }\nitem.v0 = 1\nlet archive = [{data: item}, {data: item}]\nlet out: integer = archive.first.data.v0\nexit\n';
  return [["source", source]];
})();
export const checks = ["publication"];
