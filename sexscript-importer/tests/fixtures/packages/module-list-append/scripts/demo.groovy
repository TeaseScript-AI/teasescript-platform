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
 def main() {
  loadModules(this)
  xs += [bump()]
  show("xs " + xs)
 }
}.main();
