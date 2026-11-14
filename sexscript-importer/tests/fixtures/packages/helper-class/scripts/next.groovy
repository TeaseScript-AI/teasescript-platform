def loader = new groovy.lang.GroovyClassLoader()
def ss = loader.loadClass("Helper")
ss.showWait(this, "Again", 2)
// Groovy filled the required message first and gave count its default, which TeaseScript cannot express.
ss.rounds(this, "Stroke")
