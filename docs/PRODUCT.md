# Product scope

TeaseScript is a browser-first community platform and deterministic scripting system for interactive teases, BDSM scenes, persistent personalities, roleplay adventures, and community-created packages.

The product direction includes accounts, forum, catalog, editor, player, package publishing, moderation, persistent state, media, optional integrations, and deterministic LLM-assisted dialogue. These are staged capabilities, not all current implementation.

The current implementation focus is the TypeScript language/runtime core and a local standalone development playground. Laravel, PostgreSQL, accounts, publishing, and production hosting are later milestones.

## Terminology

In product and language documentation:

- **player** means the human participating in the tease or scene;
- **player application** or **player UI** means the browser software that renders and controls the session;
- **engine** or **runtime** means the deterministic execution system inside the player application.

Use the qualified software terms instead of calling both the human and the application only “player” when the distinction matters.