/// <reference types="vite/client" />

/** The build's identity for debug exports, from `vite.config.ts`; absent where the source runs without that config. */
declare const __PLAYER_BUILD__:
  | {
      readonly commit: string | null;
      readonly dirty: boolean | null;
      readonly mode: string;
      readonly appVersion: string | null;
    }
  | undefined;
