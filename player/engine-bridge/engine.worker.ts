// The browser entry of the engine Worker. It only loads the host, so that no other chunk ever imports this one: WebKit
// evaluates a module Worker's entry a second time when a chunk imports it, which would start a second host. A host
// that fails to load is rethrown as an uncaught error, which the Worker reports, so the Player sees a startup failure.
import("./engine-host.js").catch((error: unknown) => {
  setTimeout(() => {
    throw error;
  });
});
