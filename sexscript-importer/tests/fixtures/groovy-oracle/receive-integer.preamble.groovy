def store = [:]
def show = { Object value -> println(value) }
def wait = { Object value -> }
// The legacy host (ss.desktop.Script): send() keeps the value with its type, and receiveInteger() is
// `(Integer) receive(key)` in a try that gives null on the failed cast.
def send = { key, value -> store[key] = value }
def receiveInteger = { key -> def value = store[key]; value instanceof Integer || value == null ? value : null }
