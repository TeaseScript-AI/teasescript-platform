# TikToken offline runtime payload

The matching runtime archive supplies TikToken 0.13.0, its required wheels, and the verified `o200k_base`
vocabulary under this directory. TikToken is a mandatory part of the supported ChatGPT project-agent environment.

`bin/install-tiktoken-offline.sh` is the only supported installer. It uses the host CPython 3.13 interpreter, rejects
an incompatible Python implementation, ABI, operating system, or architecture, installs only from the bundled wheel
directory, prepares TikToken's Git-local cache from the bundled vocabulary, and verifies the normal
`tiktoken.get_encoding("o200k_base")` route before exposing Git-local runners.

The runtime payload is intentionally pinned and offline. Do not add network downloads or a source-build fallback. If
the host environment stops providing compatible CPython 3.13, the installer reports the detected interpreter and the
required `cp313` payload so the runtime archive can be refreshed deliberately.
