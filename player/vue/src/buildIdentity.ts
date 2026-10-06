/** This build's identity for debug exports; every field is `null` where it is unknown, such as in tests. */
export const playerBuildIdentity = {
  commit: typeof __PLAYER_BUILD__ === "undefined" ? null : __PLAYER_BUILD__.commit,
  dirty: typeof __PLAYER_BUILD__ === "undefined" ? null : __PLAYER_BUILD__.dirty,
  mode: typeof __PLAYER_BUILD__ === "undefined" ? null : __PLAYER_BUILD__.mode,
  appVersion: typeof __PLAYER_BUILD__ === "undefined" ? null : __PLAYER_BUILD__.appVersion,
};
