def nums = [5, 6, 7]
def words = ["a", "b", "c"]
def choose = { asText -> asText ? "b" : 0 }
def item = choose(false)
nums.remove(item)
item = choose(true)
words.remove(item)
show(nums.join(","))
show(words.join(","))
