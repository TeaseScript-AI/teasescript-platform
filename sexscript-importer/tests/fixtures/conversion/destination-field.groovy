// An object field written by a method stays in reach of other functions, also when a nested block declares a
// local of the same name.
return new Object() {
	def x = 7
	def readX = { -> return x }
	def calculate() {
		if (x > 0) {
			def x = 1
			save("inner", x)
		}
		x = [1].sum { readX() }
		save("result", x)
	}
	def main() {
		calculate()
	}
}.main();
