# The desktop corpus: tooling

Kits and data on the desktop worker, indexed here and not imported: run each from its own folder there (`../README.md`,
"Kept outside the repository").

- `desktop:~/work/evidence/corpus/tooling/property-families/`: the owner's reviewer's property-family pilot (#1442;
  `property-family-pilot.zip`, sha256 `59ea4c55…`), whose portable parts are `tests/families/property/`. It also holds
  the pilot's phase-A evidence, its JSON schemas and its five historical calibrations (`calibration/`, not blinded;
  #1411's is test infrastructure). It is untrusted input, never imported into a build.
- `desktop:~/work/evidence/1463/retained/`: copies of the generators, case files and records that modules cite from
  agents' scratch folders on the main LXC (`/tmp/agent-work/...`, under the same paths), with `SHA256SUMS`.
- `desktop:~/work/evidence/corpus/tooling/`: one master copy of each kit that briefs hand out, the split kit (`split/`,
  with `cycles.cjs`) and the #1423 probe kit (`g3-probe/`, with `queue-final.sh`). Its `README.md` says what each
  master fixes.
