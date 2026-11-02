return new Object() {
	final DATAFOLDER = getDataFolder();
	final loadModules = { toy ->
		new File("$DATAFOLDER/scripts/game")
			.listFiles()
			.findAll { f -> f.name.endsWith(".groovy") }
			.collect { s -> Eval.me(s.text)(toy); }
			.findAll { p -> p };
	};

	def main() {
		def setups = loadModules(this)
		setups.each { p -> p() }
		play()
		extra()
	}
}.main();
