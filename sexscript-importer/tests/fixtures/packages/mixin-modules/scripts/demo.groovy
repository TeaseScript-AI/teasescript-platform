return new Object() {
	final DATAFOLDER = getDataFolder();
	final loadModules = { toy ->
		new File("$DATAFOLDER/scripts/demo")
			.listFiles()
			.findAll { f -> f.name.endsWith(".groovy") }
			.collect { s -> Eval.me(s.text)(toy); }
			.findAll { p -> p };
	};
	int rounds = 2

	def main() {
		loadModules(this)
		greet()
		show("Rounds: " + rounds)
	}
}.main();
