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
// A nested map's keys read as a map's too, a key "size" also; an array keeps its positions.
def data = new groovy.json.JsonSlurper().parseText('{"config": {"title": "Yes", "size": 3}, "rolls": [4, 6]}')
def inner = data.config
show(data.config.title + " " + inner.size + " " + data.rolls[1])
// A map that takes the place of a parse is a dict as well, and a list's size is its length.
def fallback = new groovy.json.JsonSlurper().parseText('null')
if (fallback == null) fallback = [title: "Fallback"]
show(fallback.title + " " + data.rolls.size)
