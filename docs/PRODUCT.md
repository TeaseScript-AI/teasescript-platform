# Product scope

TeaseScript is a browser-first community platform and deterministic scripting system for interactive teases, BDSM scenes,
persistent personalities, roleplay adventures, and community-created packages. Its language and editor serve creators
who want to turn an idea into an interactive story, including people who have never programmed. Prior software-development
or frontend-design experience is not assumed. Players are the people who experience those stories.

The product direction includes accounts, forum, catalog, editor, player, package publishing, moderation, persistent state,
media, optional integrations, and deterministic LLM-assisted dialogue. These are staged capabilities, not all current
implementation. Authoring should offer an easy starting point and room for experienced developers to express complex
ideas within the platform's accepted execution and capability boundaries. The
[language design intent](TEASESCRIPT.md#language-design-intent) defines how defaults and optional advanced controls
support that progression in the language and editor.

The current implementation focus includes the deterministic TypeScript language/runtime core, the local development
playground, and the production-direction Vue Player foundation. Laravel, PostgreSQL, accounts, publishing, and
production hosting are later milestones.

## Terminology

In product and language documentation:

- **creator** or **script author** means the human writing an interactive story or package;
- **player** means the human participating in the tease or scene;
- **player application** or **player UI** means the browser software that renders and controls the session;
- **engine** or **runtime** means the deterministic execution system inside the player application.

Use the qualified software terms instead of calling both the human and the application only “player” when the distinction matters.
