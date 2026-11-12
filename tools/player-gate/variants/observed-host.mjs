// The Player's host object (`usePlayerSession`) for the gate's driver, which acts on it as a host does, such as
// preparing another Start (`prepare`): `main.ts` gets this module instead of `hostedScript.ts`. It records the object in
// `globalThis.__gatePlayer`, then prepares the hosted script as the product does.
import { prepareHostedScript as prepareProduct } from "../../../player/vue/src/hostedScript.ts";

export function prepareHostedScript(player, host) {
  globalThis.__gatePlayer = player;
  return prepareProduct(player, host);
}
