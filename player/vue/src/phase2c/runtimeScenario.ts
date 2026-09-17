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
