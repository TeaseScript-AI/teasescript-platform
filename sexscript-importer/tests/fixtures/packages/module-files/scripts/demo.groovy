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
	boolean enabled = false
	// A field that only a module uses is the object's field there too.
	def boost = 1.5
	def pauseCycle = { int delay, int cycle = 60 -> wait(delay / cycle) }

	def main() {
		def setups = loadModules(this)
		setups.each { p -> p() }
		greet()
		def cycle = pauseCycle
		cycle(120)
		show("Rounds: " + rounds)
	}
}.main();
