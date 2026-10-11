def store = [:]
def show = { Object value -> println(value) }
def wait = { Object value -> }
// The legacy host (ss.desktop.Script, ss.PropertiesWorker): send() keeps a value's text (String.valueOf), receive()
// reads it back as an Integer where Integer.parseInt() takes it, else as a Float where Float.parseFloat() does, else as
// the text, and receiveInteger() is `(Integer) receive(key)` in a try that gives null on the failed cast.
def send = { key, value -> store[key] = String.valueOf(value) }
def receive = { key ->
  def text = store[key]
  if (text == null) return null
  try { return Integer.parseInt(text) } catch (NumberFormatException e) { }
  try { return Float.parseFloat(text) } catch (NumberFormatException e) { }
  text
}
def receiveInteger = { key -> def value = receive(key); value instanceof Integer ? value : null }
