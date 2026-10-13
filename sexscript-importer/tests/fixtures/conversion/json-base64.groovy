// JSON and Base64 text (V30 §30): JsonOutput.toJson() is toJson(), a text's bytes in Base64 toBase64(), decodeBase64()
// bytes that new String() makes text again fromBase64(), and a JsonSlurper's parseText() fromJson(). Text that is not
// Base64 or JSON gives a default where Groovy failed, here into the catch, which returned null as fromJson() does.
def encode = { input ->
    def json = groovy.json.JsonOutput.toJson(input)
    return json.bytes.encodeBase64().toString()
}
def decode = { report ->
    try {
        byte[] decoded = report.decodeBase64()
        def json = new String(decoded)
        def jsonSlurper = new groovy.json.JsonSlurper()
        return jsonSlurper.parseText(json)
    }
    catch(Exception e) {
        return null
    }
}
// The parsed object's keys read as a map's, through the function that returns it.
def config = [title: "Toy-ID-1", durationRange: [minimum: 30, maximum: 35]]
def report = decode(encode([presetTitle: config.title, violations: 2]))
if (!report) show("I cannot read your report")
else if (config.title != report.presetTitle) show("That is not the corner time I ordered")
else if (report.violations > 1) show("You moved " + report.violations + " times")
def size = new groovy.json.JsonSlurper().parseText('{"size": 3}').size
show("Size " + size)
