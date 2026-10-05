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
