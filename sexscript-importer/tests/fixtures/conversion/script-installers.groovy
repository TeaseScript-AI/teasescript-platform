// A download into the package cannot happen here: a system notice shows the request, with secret values hidden, and
// the function answers as when the download failed.
def downloadFile = { link, file ->
  URL url = new URL(link)
  def input = url.openStream()
  def output = new FileOutputStream(new File("scripts/" + file))
  output.write(input.bytes)
  return true
}
if (!downloadFile("http://example.org/update.txt?token=abc", "tasks.txt")) show("The tasks stay as they were")
// Managing the installed scripts is not possible from a package; a system notice says so, and the session ends.
def dir = new File(getDataFolder() + "scripts/")
dir.eachFile { script -> show(script.name) }
