// Astra review.
export const cases = (() => {
  const source =
    "let packet = {random: 4.5}\nlet whole: integer = packet.random\nsay whole\nexit\n";
  return [["source", source]];
})();
export const checks = ["publication"];
