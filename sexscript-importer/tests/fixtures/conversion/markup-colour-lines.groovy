// PainStacks: a colour around several paragraphs colours each line of them, in one message.
show("<b>status</b>\n\n<span style='color: #696969';>waiting for signal\n\ncountdown to end\n\nconcluded</span>")
// interrogation: a colour that closes before the bold inside it closes the bold first.
def prompt = "Kneel"
prompt = "<h1><font color=red><b>" + prompt + "</font></h1></b>"
show(prompt)
