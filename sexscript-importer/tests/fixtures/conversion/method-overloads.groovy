// An object method overload that only casts its parameters for another overload of the same name and arity: the one
// converted function casts them itself.
return new Object() {
	int steps(int count, String label) { save(label, count * 2) }
	int steps(double count, String label) { steps((int) count, label) }
	def main() {
		steps(2.5, "steps")
		steps(3, "more")
	}
}.main();
