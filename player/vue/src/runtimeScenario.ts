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

// Development camera content: the session camera opens after Start, and `takePhoto()` captures silently from it.
export const cameraScenarioSource = `
speaker guide { title: "Camera Guide" }
playAudio async "sounds/chime.wav"
say as guide "The camera is ready.", instant
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
