// Development opening content, compiled and completed through the canonical runtime adapter until a real
// demo script replaces it.
export const openingScenario = `
speaker guide { title: "Coastal Guide" }
say as guide "Where would you like to go?", instant
let answer = choose as guide coast: { text: "Stay by the water", background: "seagreen" }, lights: { text: "Follow the lights", background: "gold" }, harbour: { text: "Explore the old harbour", background: "hsl(265 45% 50%)" }, sunset: "Wait for sunset", long: "Take the longer path along the water so we can finish our conversation before reaching the lighthouse."
showButton as guide "Continue", background: "seagreen"
let next = choose as guide stay: "Stay a little longer", walk: "Walk together"
showButton as guide "Finish"
exit
`;
