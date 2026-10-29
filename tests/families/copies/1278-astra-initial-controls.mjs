// #1278; Astra review.
export const cases = (() => {
  const sources = {
    partial:
      'let p={wanted:1}\nlet q={different:1}\nlet options=[{text:"a",value:p},{text:"b",value:q}]\nlet picked=askChoice options\nrepeat picked.wanted {}\nrepeat picked.wanted {}\nexit',
    added:
      'let p={wanted:1}\nlet q={different:1}\nq.wanted=2\nlet options=[{text:"a",value:p},{text:"b",value:q}]\nlet picked=askChoice options\nrepeat picked.wanted {}\nrepeat picked.wanted {}\nexit',
    ownWriter:
      'let options=[{text:"a",value:{f:1}},{text:"b",value:{f:2}},{text:"c",value:{f:3}}]\nlet picked=askChoice options\nsay picked.missing\nexit',
    original:
      'let payload={f:1}\nlet options=[{text:"a",value:payload},{text:"b",value:payload}]\nlet picked=askChoice options\nsay picked.missing\nexit',
  };
  return Object.entries(sources);
})();
export const checks = ["publication"];
