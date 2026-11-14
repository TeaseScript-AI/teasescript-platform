// A module's function sets the script's list while the value appended to it is computed: Groovy read the list
// before, so the append keeps reading it first.
return new Object() {
 final DATAFOLDER = getDataFolder();
 final loadModules = { toy ->
  new File("$DATAFOLDER/scripts/demo")
   .listFiles()
   .findAll { f -> f.name.endsWith(".groovy") }
   .collect { s -> Eval.me(s.text)(toy); }
   .findAll { p -> p };
 };
 def xs = [0]
 def ys = [0]
 def zs = [0]
 // A function of this file can call another file's code too: through a closure it runs, or in a default value.
 def dispatch(f) { f() }
 def pick(n = bump()) { return n }
 def main() {
  loadModules(this)
  xs += [bump()]
  show("xs " + xs)
  def choices = [outer: { -> bump() }]
  ys += [dispatch(choices.outer) as int]
  show("ys " + ys)
  zs += [pick()]
  show("zs " + zs)
 }
}.main();
