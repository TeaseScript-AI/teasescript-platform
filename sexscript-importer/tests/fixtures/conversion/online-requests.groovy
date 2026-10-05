// An online service cannot answer here: a system notice shows the request, with secret values hidden, and the
// read is null, as when the request failed.
def userId = loadString("training.id")
def request = "https://example.org/cases.php?id=" + userId + "&apikey=SECRET&version=3"
def answer = request.toURL().text
if (answer == null) show("We are having trouble connecting to the internet.")
def page = new URL("http://example.org/api?token=abc&page=1").text
show("Page " + page)
