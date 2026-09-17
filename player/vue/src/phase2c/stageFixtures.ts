// Local development artwork: contrasting skies and fine detail expose fit/chrome problems.
function scene(width: number, height: number, dark = false) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid slice">
    <defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="${dark ? '#172a46' : '#d6e7ed'}"/><stop offset="1" stop-color="${dark ? '#aa7972' : '#f5dcb0'}"/></linearGradient>
    <pattern id="water" width="90" height="35" patternUnits="userSpaceOnUse"><path d="M0 12h40m15 15h25" stroke="#cee2df" opacity=".4" stroke-width="2"/></pattern></defs>
    <path fill="url(#sky)" d="M0 0h1000v1000H0z"/>
    <circle cx="740" cy="250" r="75" fill="#fff1c9"/>
    <path d="M0 490 170 290 350 530 620 410 1000 590V1000H0Z" fill="#627e86"/>
    <path d="M0 620Q400 480 1000 630V1000H0Z" fill="#426d79"/>
    <path d="M0 620Q400 480 1000 630V1000H0Z" fill="url(#water)"/>
    <path d="M0 780Q170 620 310 880L490 1000H0Z" fill="#273e43"/>
    <path d="m0 930 80-150 25 150 90-90 60 160H0" fill="#182f34"/>
  </svg>`;
  return { src: `data:image/svg+xml,${encodeURIComponent(svg)}`, alt: `${dark ? 'Dusk' : 'Daylight'} coastal landscape, development illustration` };
}
export const stageFixtures = {
  Landscape: scene(1600, 900),
  Portrait: scene(800, 1200, true),
  Square: scene(1000, 1000),
  Empty: undefined,
};
