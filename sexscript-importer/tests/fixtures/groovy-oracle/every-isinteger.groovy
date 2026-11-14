def check = { String strRange ->
	if (strRange.indexOf('-') >= 0) {
		List range = strRange.split('-').collect()
		if (range.every { r -> return r.isInteger() }) {
			int min = range[0].toInteger()
			int max = range[1].toInteger()
			show("Range " + min + " " + max)
			return
		}
	}
	show("Invalid " + strRange)
}
check("3-9")
check("a-9")
check("12")
