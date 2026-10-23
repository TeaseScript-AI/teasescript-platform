import { ONLINE_TOKEN_ITEM } from "../player/player-data.js";
import type { TestServerState } from "./server.js";

/**
 * The stand-in for the website (README.md): it opens the Player stand-alone or online, as the one account, and flips
 * the server's switches. Its texts are for testing only; no product account screen is designed here.
 */
export function hostPage(page: {
  readonly account: string;
  readonly token: string;
  readonly packages: readonly string[];
  readonly latency: {
    readonly normalMs: number;
    readonly slowMs: number;
    readonly jitterMs: number;
  };
  readonly state: TestServerState;
  readonly profile: string;
}): string {
  const config = JSON.stringify({
    token: page.token,
    tokenItem: ONLINE_TOKEN_ITEM,
    state: page.state,
    profile: JSON.parse(page.profile),
  }).replaceAll("<", "\\u003c");
  const options = page.packages
    .map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`)
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TeaseScript test server</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.5; }
  body { margin: 0; padding: 1rem; }
  main { max-width: 36rem; margin: 0 auto; }
  section { border-top: 1px solid color-mix(in srgb, currentColor 20%, transparent); padding: 0.5rem 0 1rem; }
  h1 { font-size: 1.5rem; margin: 0.5rem 0; }
  h2 { font-size: 1.1rem; margin: 0.5rem 0; }
  label { display: flex; align-items: center; gap: 0.5rem; min-height: 2.75rem; }
  fieldset { border: 0; margin: 0; padding: 0; }
  legend { padding: 0; }
  select, textarea, button { font: inherit; }
  select, button { min-height: 2.75rem; }
  button { padding: 0 1rem; }
  textarea { width: 100%; box-sizing: border-box; min-height: 9rem; font-family: ui-monospace, monospace; }
  .row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
  .quiet { opacity: 0.75; }
</style>
</head>
<body>
<main>
<h1>TeaseScript test server</h1>
<section>
<h2>Play</h2>
<label>Script <select id="script"><option value="">Repository demo</option>${options}</select></label>
<div class="row">
<button id="standalone" type="button">Stand-alone</button>
<button id="online" type="button">Online (as ${escapeHtml(page.account)})</button>
</div>
</section>
<section>
<h2>Server</h2>
<fieldset>
<legend>Latency</legend>
<label><input type="radio" name="latency" value="normal"> Normal, about ${page.latency.normalMs} ms</label>
<label><input type="radio" name="latency" value="slow"> Slow, about ${page.latency.slowMs} ms</label>
</fieldset>
<label><input type="checkbox" id="down"> Server down</label>
<div class="row">
<button id="fail" type="button">Fail the next write</button>
<span id="fail-status" role="status"></span>
</div>
</section>
<section>
<h2>Profile</h2>
<p class="quiet">The person fields online sessions start with, as JSON.</p>
<textarea id="profile" spellcheck="false" aria-label="Profile"></textarea>
<div class="row">
<button id="save-profile" type="button">Save profile</button>
<span id="profile-status" role="status"></span>
</div>
</section>
</main>
<script type="application/json" id="config">${config}</script>
<script>
const config = JSON.parse(document.getElementById("config").textContent);
const element = (id) => document.getElementById(id);
const script = () => element("script").value;
const address = (...parts) => "/player/?" + parts.filter(Boolean).join("&");
const packagePart = () => (script() === "" ? "" : "package=" + encodeURIComponent(script()));
element("standalone").onclick = () => {
  sessionStorage.removeItem(config.tokenItem);
  location.href = address(packagePart());
};
element("online").onclick = () => {
  sessionStorage.setItem(config.tokenItem, config.token);
  location.href = address("data=online", "server=/api/", packagePart());
};
async function change(update) {
  const response = await fetch("/test-server/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  const reply = await response.json();
  if (!response.ok) throw new Error(reply.error);
  show(reply);
  return reply;
}
let polling = null;
function show(state) {
  for (const radio of document.querySelectorAll("input[name=latency]"))
    radio.checked = radio.value === (state.slow ? "slow" : "normal");
  element("down").checked = state.down;
  element("fail").disabled = state.failNextWrite;
  element("fail-status").textContent = state.failNextWrite ? "Waiting for the next write." : "";
  clearInterval(polling);
  if (state.failNextWrite)
    polling = setInterval(() => fetch("/test-server/state").then((reply) => reply.json()).then(show), 2000);
}
for (const radio of document.querySelectorAll("input[name=latency]"))
  radio.onchange = () => change({ slow: radio.value === "slow" });
element("down").onchange = () => change({ down: element("down").checked });
element("fail").onclick = () => change({ failNextWrite: true });
element("profile").value = JSON.stringify(config.profile, null, 2);
element("profile").oninput = () => (element("profile-status").textContent = "");
element("save-profile").onclick = async () => {
  const status = element("profile-status");
  try {
    await change({ profile: JSON.parse(element("profile").value) });
    status.textContent = "Saved.";
  } catch (error) {
    status.textContent = error.message;
  }
};
show(config.state);
</script>
</body>
</html>
`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
