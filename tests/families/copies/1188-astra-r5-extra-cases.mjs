// astra-m4-i1188-recheck-r5-evidence; archived Python/shell evidence.
export const cases = (() => {
  let cases;
  cases = [];
  function add(name, decl, tail) {
    let src;
    src =
      decl +
      '\nlet origin={meta:{v:seed},keep:true}\nlet rejected=[{meta:{v:"blocked"},keep:true},origin]\n' +
      tail +
      "\nexit\n";
    cases.push({ name: "extra/" + name, source: src });
  }
  add("copy-receiver", "let seed:integer=9", "let target=origin\ntarget=rejected.first");
  add(
    "copy-union-excludes",
    "let seed:integer | boolean=9",
    "let target=origin\ntarget=rejected.first",
  );
  add("copy-optional-excludes", "let seed:integer?=9", "let target=origin\ntarget=rejected.first");
  add(
    "projection-copy-receiver",
    "let seed:integer=9",
    "let holder={content:origin}\nlet target=holder.content\ntarget=rejected.first",
  );
  add(
    "copied-live-input",
    "let seed:integer=9",
    "let first=rejected\nlet second=first\nlet target=origin\ntarget=second.first",
  );
  add("copy-union-fits", "let seed:integer | string=9", "let target=origin\ntarget=rejected.first");

  return cases.map((c) => [c.name, c.source]);
})();
export const checks = ["publication"];
