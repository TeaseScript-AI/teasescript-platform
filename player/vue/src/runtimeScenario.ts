// Development opening content, compiled and completed through the canonical runtime adapter until a real
// demo script replaces it.
export const openingScenario = `
speaker guide { title: "Coastal Guide" }
showImage "images/coast.svg"
playAudio async "sounds/chime.wav"
say as guide "Where would you like to go?", instant
let answer = choose as guide coast: { text: "Stay by the water", background: "seagreen" }, lights: { text: "Follow the lights", background: "gold" }, harbour: { text: "Explore the old harbour", background: "hsl(265 45% 50%)" }, sunset: "Wait for sunset", long: "Take the longer path along the water so we can finish our conversation before reaching the lighthouse."
showButton as guide "Continue", background: "seagreen"
showImage "images/dusk.svg"
let next = choose as guide stay: "Stay a little longer", walk: "Walk together"
showButton as guide "Finish"
exit
`;

// Development camera content in the repository demo's voice: the session camera opens after Start, `takePhoto()`
// captures silently from it once she has said so, and the saved photo is shown again in a later run.
export const cameraScenarioSource = `
speaker mistressVera {
    title: "Mistress"
    firstName: "Vera"
    color: "#c2185b"
    avatar: "avatars/mistress-vera.svg"
}
speaker mistressVera
showImage "images/playroom.svg"
playAudio async "sounds/command-chime.wav"
let previous: string? = load "camera.photo"
if previous != null {
    showImage previous
    say "Look what I kept from last time.", instant
    showButton "Take another, Mistress"
}
say "Face the camera and hold still. I'm taking your picture.", instant
let photo: string? = takePhoto()
if photo != null {
    showImage photo
    save photo as "camera.photo"
    say "Got you. That one is mine now.", instant
} else {
    say "No camera? Then you stay unseen, for now. We go on without a photo.", instant
}
showButton "Yes, Mistress"
exit
`;

// Development camera view content: the script shows the camera in the floating window while the player gets into frame,
// takes the photo, moves the camera view over the Stage image, and hides it. The script alone takes the photo.
export const viewfinderScenarioSource = `
speaker mistressVera {
    title: "Mistress"
    firstName: "Vera"
    color: "#c2185b"
    avatar: "avatars/mistress-vera.svg"
}
speaker mistressVera
showImage "images/playroom.svg"
say "Time for your picture. Get into the frame and look at me.", instant
let view = showCamera
showButton "I'm ready, Mistress"
let photo: string? = takePhoto()
if photo != null {
    showImage photo
    say "There you are. I'll keep that one.", instant
} else {
    say "No camera? Then you stay unseen, for now. We go on without a photo.", instant
}
showButton "Put me on your Stage"
view.placement = "stage"
say "Now you are on my Stage, over your picture.", instant
showButton "Yes, Mistress"
hideCamera
exit
`;
