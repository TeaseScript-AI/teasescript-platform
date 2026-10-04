/** The files the editor opens with: a small project whose headers fill the file overview. */
export const sampleProject: readonly { readonly path: string; readonly text: string }[] = [
  {
    path: "main.tease",
    text: `---
title: "Evening session"
author: "TeaseScript examples"
description: "Greets the player and explains the rules."
tags: "intro"
keywords: "beginner", "short session"
---
say "Hello, editor!", instant
showButton "Continue"
exit
`,
  },
  {
    path: "rooms/hall.tease",
    text: `---
title: "The hall"
description: "A calm room to wait in between tasks."
tags: "room", "calm"
---
say "Wait in the hall."
exit
`,
  },
  {
    path: "tasks/corner.tease",
    text: `---
title: "Corner time"
author: "TeaseScript examples"
description: "Corner time with lines, for after a failed task."
tags: "punishment", intensity: 3
---
say "Go to the corner."
exit
`,
  },
];
