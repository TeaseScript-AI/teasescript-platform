// Stay: an admission must start with "I ", and the script shows it again in a span. Legacy's field held one line, so a
// line break typed in the answer becomes a space where it is asked.
def whyhere = getString("Admit what you have done wrong. Use words that begin with I.", "")
if (whyhere.length() > 4 && whyhere.toLowerCase().substring(0, 2) == "i ") show("Say it out loud: <b>" + whyhere + "</b>")
save("stay.why", whyhere)
// An answer that the script ignores keeps its line breaks.
getString("Round 1")
