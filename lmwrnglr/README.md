# lmwrnglr

A multi-terminal manager for AI coding sessions. Manage multiple terminal panes within a single window, with deep Claude Code integration, session persistence, and AI-powered terminal summaries.

## What it does

- **Multi-terminal management**: Create, resize, split (horizontal/vertical), and switch between multiple terminal panes within tabs
- **Session persistence**: Auto-saves workspace layouts; restore named sessions
- **Claude Code integration**: Monitors Claude Code activity across terminals and displays live session status
- **AI summaries**: Uses the Claude API (Haiku model) to summarise terminal activity
- **Auto-updates**: Built-in update checking and installation via GitHub Releases

## Requirements

- macOS 13+ (Apple Silicon or Intel — universal binary)
- [Node.js](https://nodejs.org/) LTS (v20+) with npm v10+
- [Rust](https://rustup.rs/) 1.77.2+
- Xcode Command Line Tools (`xcode-select --install`)
- [Tauri CLI](https://tauri.app/start/prerequisites/) (installed via npm)

## Building

```bash
# Install frontend dependencies
npm install

# Development (hot-reload)
npm run dev

# Production build (generates the .app bundle in src-tauri/target/)
npm run tauri build -- --target universal-apple-darwin
```

## Running tests

```bash
npm run test:run      # single run
npm run test          # watch mode
npm run coverage      # coverage report → coverage/
```

## Configuration

Set the following environment variable (or configure via the in-app Preferences modal):

| Variable | Purpose |
|----------|---------|
| `CLAUDE_WRANGLER_LLM_KEY` | Anthropic API key used for terminal-activity summaries |

## Releasing

Releases are published automatically when a tag matching `lmwrnglr/v*` is pushed. The GitHub Actions workflow builds a universal macOS binary, signs it, and uploads it to GitHub Releases.

```bash
git tag lmwrnglr/v0.2.0
git push origin lmwrnglr/v0.2.0
```

Versions must be strict semver (no leading zeros in pre-release identifiers).
