# Product scope

TeaseScript is a browser-first community platform and deterministic scripting system for interactive teases, BDSM scenes,
persistent personalities, roleplay adventures, and community-created packages. Its language and editor serve creators
who want to turn an idea into an interactive story, including people who have never programmed. Prior software development
or frontend design experience is not assumed. Players are the people who experience those stories.

The product direction includes accounts, forum, catalog, editor, player, package publishing, moderation, persistent state,
media, optional integrations, and deterministic LLM-assisted dialogue. These are staged capabilities, not all current
implementation. Authoring should offer an easy starting point and room for experienced developers to express complex
ideas within the platform's accepted execution and capability boundaries. The
[language design intent](TEASESCRIPT.md#language-design-intent) defines how defaults and optional advanced controls
support that progression in the language and editor.

The current implementation focus includes the deterministic TypeScript language/runtime core, the local development
playground, and the Vue Player. Laravel, PostgreSQL, accounts, publishing, and
production hosting are later milestones.

## Terminology

In product and language documentation:

- **creator** means the person writing a Tease. The script header field remains `author:`.
- **player** means the person playing a Tease.
- **user** means anyone with an account; a user can be a creator, a player, or both.
- **Playroom** means the software that plays Teases: the player plays in the Playroom.
- **engine** or **runtime** means the deterministic execution system inside the Playroom.
- **Writer's Den**, or **the Den** after its first mention, means the editor where creators write Teases.
- **Tease** means the published unit a creator ships: its scripts, media and libraries. Each Tease has an immutable
  **tease id**.
- **script** means one `.tease` file. The **main script**, `main.tease`, is where a Tease starts.
- **session** means one play-through, from Start to `exit`, including pauses and Continue.
- **speaker** means a speaking identity in a script, including the built-in `player`.
- **personality** is not built or designed yet; see [Ideas for later](#ideas-for-later-persistent-personalities).
- **tease catalog** means the website listing of published Teases. Use **image catalog** for the image collection.
- **player profile**, or **profile** when clear, means the player's personal details, settings, limits and kink
  ratings. Playroom settings are application preferences.
- **saved data** means values a script stores with `save` for later sessions. A **checkpoint** is the technical engine
  representation used to resume a session.

The cross-player data API names are `publishToPlayers`, `loadFromPlayers`, `countPlayers`, `claimFromPlayers` and
`removeFromPlayers`. A Tease reads and writes another Tease's saved data for the same player with `load` and `save` with
`teaseId:`, and reads that Tease's run history with `getTeaseMetadata`.

## Ideas for later: persistent personalities

Not built and not designed. This is an owner idea of 2026-10-25, to be worked out later; it is not accepted design.

- A **personality** is a speaker with planned events: a persistent character, such as a mistress or a master, who
  continues across Teases instead of living inside one.
- A player links a personality to their account, and Teases by different creators copy it, as the player speaker is
  taken from the player profile. The Teases a player plays then feel like one character's continuing story.
- A personality could give assignments, such as Teases to play, as a kind of to-do list.
- A player profile is itself a kind of persistent personality: a group of settings kept with the account.
- A personality could carry its own system prompt for LLM dialogue, describing how it behaves.
- Image tags can select the photos for the active personality in every Tease. Personalities can then be swapped while
  the story stays consistent, provided their images carry matching tags.
