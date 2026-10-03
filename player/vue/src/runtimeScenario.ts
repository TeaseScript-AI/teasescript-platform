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

// Development camera content: the session camera opens after Start, `takePhoto()` captures silently from it, and
// the saved photo is shown again in a later run.
export const cameraScenarioSource = `
speaker guide { title: "Camera Guide" }
playAudio async "sounds/chime.wav"
let previous: string? = load "camera.photo"
if previous != null {
    showImage previous
    say as guide "Your previous photo.", instant
    showButton as guide "Take a new photo"
}
say as guide "The camera is ready.", instant
let photo: string? = takePhoto()
if photo != null {
    showImage photo
    save photo as "camera.photo"
    say as guide "Captured.", instant
} else {
    say as guide "No camera; continuing without a photo.", instant
}
showButton as guide "Finish"
exit
`;

// Development viewfinder content: the preview shows the viewfinder while the script waits on "Take photo", standing in
// for a viewfinder request the language cannot express yet. The script alone takes the photo, right after the press.
export const viewfinderScenarioSource = `
speaker guide { title: "Camera Guide" }
showImage "images/coast.svg"
say as guide "Time for a photo. Get into the frame and face the camera.", instant
showButton as guide "Take photo"
let photo: string? = takePhoto()
if photo != null {
    showImage photo
    say as guide "Captured.", instant
} else {
    say as guide "No camera; continuing without a photo.", instant
}
showButton as guide "Finish"
exit
`;
