/**
 * Deliberately internal marker for platform-owned capability brokering.
 * No browser or host capability is implemented in this POC.
 */
export interface PrivilegedPlatformAdapterMarker {
  readonly internalOnly: true;
}

export const privilegedPlatformAdapterMarker: PrivilegedPlatformAdapterMarker =
  Object.freeze({ internalOnly: true });
