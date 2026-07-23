# ADR 0008 — Event execution locations

**Status:** Accepted; exact API remains open

Persistent events declare whether work runs on the server, in the browser, through a future helper, or as a client-required interaction. Local or interactive actions must not be executed incorrectly on the server.
