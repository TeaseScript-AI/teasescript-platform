// Device programs on the player's computer cannot run from a package; a permanent button shows each device's state.
def path = getDataFolder()
def estim_start = loadString("training.estim_start")
def estim_finish = loadString("training.estim_finish")
def lock_start = loadString("training.lock")
def arm_finish = loadString("training.disarm")
if (lock_start != "") useFile(path + "/" + lock_start)
useFile(path + "/" + estim_start)
wait(2)
useFile(estim_finish)
useFile(path + "/" + arm_finish)
// An open CD tray is a button; clicking it closes the tray.
openCdTrays()
show("Put the key in the tray")
// A command variable named for the switch state it sets shows that state.
def switchbox_on = 0, switchbox_off = 0
switchbox_on = "usbcontrol.exe " + loadInteger("training.switchbox") + " on"
switchbox_on.toString().execute()
switchbox_off = 1
switchbox_off.toString().execute()
