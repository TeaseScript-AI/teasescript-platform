// Development source, compiled and completed through the canonical runtime adapter.
export const runtimeScenario = `
speaker guide {
  title: "Coastal Guide"
}
say as guide "Welcome to the **coast**. [Map](https://example.com/coast) [spoiler]The lighthouse is open.[/spoiler]", instant
let answer = askText as guide "Your reply"
say as guide "# Along the shore\\n> Take your time.\\n- Listen to the sea\\n- Watch the light\\n3. Follow the path\\n\\n*Quiet* \`code\` ~~rush~~ [u]waves[/u] [color=#456789]blue[/color] [bg=#ffee88]sun[/bg] [weight=light]soft[/weight] [size=large]horizon[/size]", instant
showButton as guide "Continue **literally**"
say "The walk continues. <b>This is literal text.</b>", instant
exit
`;

// Exercises all foreground kinds without adding completion controls to Visual Lab.
export const interactionScenario = `
speaker guide {
  title: "Coastal Guide"
}
say as guide "Try the foreground interactions.", instant
let answer = askText as guide "Your reply"
let amount = askNumber as guide "Your number"
let direction = choose as guide left: "Left", right: "Right"
let duplicate = choose as guide first: "Same", second: "Same"
showButton as guide "Finish"
say as guide "${"${answer}"} / ${"${amount}"} / ${"${direction}"} / ${"${duplicate}"}", instant
exit
`;

// Direct visual entry point; the all-interactions fixture remains available separately.
export const buttonScenario = `
speaker guide { title: "Coastal Guide" }
say as guide "Where would you like to go?", instant
let answer = choose as guide coast: { text: "Stay by the water", background: "seagreen" }, lights: { text: "Follow the lights", background: "gold" }, harbour: { text: "Explore the old harbour", background: "hsl(265 45% 50%)" }, sunset: "Wait for sunset", long: "Take the longer path along the water so we can finish our conversation before reaching the lighthouse."
showButton as guide "Continue", background: "seagreen"
let next = choose as guide stay: "Stay a little longer", walk: "Walk together"
showButton as guide "Finish"
exit
`;

// A completed reply keeps the player bubble, speaker changes and active choices visible together.
export const spacingScenario = `
speaker guide { title: "Coastal Guide" }
speaker keeper { title: "Harbour Keeper" }
say as guide "The path splits just beyond the dunes.", instant
say as guide "We can still hear the water from here.", instant
let reply = askText as guide "Your reply"
say as keeper "The lighthouse path is open tonight.", instant
say as guide "Where would you like to go?", instant
let direction = choose as guide shore: "Walk by the water", light: "Visit the lighthouse", harbour: "Return to the harbour"
exit
`;
