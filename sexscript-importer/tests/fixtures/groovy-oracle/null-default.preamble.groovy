def store = [:]
def show = { Object value -> println(value) }
def wait = { Object value -> }
def save = { key, value -> store[key] = value }
def loadInteger = { key -> def value = store[key]; value == null ? null : new Double(value.toString()).intValue() }
def load = { key -> store[key] }
