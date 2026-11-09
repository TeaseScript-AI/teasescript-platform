// The Player browser smoke's server (`tools/player-browser-smoke.mjs`): the playground over the test packages.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createPlaygroundServer } from "../../dist/playground/server.js";

/** The smoke's playground server over the test packages, with the `/smoke/` route to the compiled Player modules. */
export async function startSmokeServer() {
  // house compiles and starts at its main.tease; broken does not compile.
  const server = createPlaygroundServer({
    packagesRoot: fileURLToPath(new URL("../../tests/fixtures/packages/", import.meta.url)),
  });
  const [handleRequest] = server.listeners("request");
  server.removeAllListeners("request");
  server.on("request", (request, response) => {
    // The spill store's module and the compiled Player modules it imports, by their path under `dist/player/`.
    const smokeModule = /^\/smoke\/((?:[a-z-]+\/)*[a-z-]+\.js)$/u.exec(request.url ?? "");
    if (smokeModule !== null) {
      void readFile(new URL(`../../dist/player/${smokeModule[1]}`, import.meta.url)).then(
        (module) => {
          response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
          response.end(module);
        },
        () => {
          response.writeHead(404);
          response.end();
        },
      );
      return;
    }
    handleRequest(request, response);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("No server address.");
  const origin = `http://127.0.0.1:${address.port}`;
  return { server, address, origin };
}
