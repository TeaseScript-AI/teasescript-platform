# Continuous personalities

Finite sessions and long-running personalities use the same parser, runtime, state model, and save/checkpoint format. The deterministic engine remains authoritative.

The intended capability includes persistent personality instances, assignments, reports, permissions, statuses, scheduled work, task queues, reconnect behavior, and bounded LLM dialogue. Exact lifecycle state machines, data contracts, ownership, missed-event behavior, and concurrency remain open. Do not implement a separate personality engine.
