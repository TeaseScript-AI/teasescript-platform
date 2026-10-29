// #1165 / S8; Astra review.
export const cases = (() => {
  const sources = {
    get: 'let items = [2, 3]\nsay items.get(hostOther, default: hostValue)\nsay "AFTER"\nexit\n',
    written:
      'let items: integer[] = [2, 3]\nsay items.get(hostOther, default: hostValue)\nsay "AFTER"\nexit\n',
    otherwise: 'let item: integer? = hostOther\nsay item otherwise hostValue\nsay "AFTER"\nexit\n',
    paired:
      "let anchor = 4\nlet value = anchor otherwise hostValue\nlet items = [2, 3]\nsay items.get(hostOther, default: hostValue)\nsay value\nexit\n",
  };
  return Object.entries(sources);
})();
export const checks = ["publication", "stops"];
