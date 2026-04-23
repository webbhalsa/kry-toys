# kry-toys

A monorepo of tools and applications built by the Kry team. Anyone at Kry is welcome to add a new project here.

## Applications

| App | Description |
|-----|-------------|
| [lmwrnglr](./lmwrnglr/) | Multi-terminal manager for AI coding sessions. Manage multiple terminal panes in a single window with Claude Code integration and session persistence. |

---

## Adding a New Application

Every application lives in its own top-level folder and must follow a few rules so the repo stays clean.

### Rules

1. **Unique name** — pick a folder name that isn't already used.
2. **Self-contained** — your application folder is yours. Do **not** modify any other folder or file except:
   - The root `README.md` — add one row to the Applications table above.
   - `.github/workflows/` — you may add workflow files **scoped to your folder** (see below).
3. **Your own README** — every application must have a `README.md` inside its folder describing what it does, how to build it, and what it requires.
4. **Releases via git tags** — if you publish releases, use tags of the form `<app-name>/v<semver>` (e.g. `my-tool/v1.0.0`). This keeps tags namespaced and avoids conflicts.

### Step-by-step

```
kry-toys/
└── your-app-name/
    ├── README.md        ← required
    ├── src/
    ├── ...
    └── (your files)
```

1. Create a folder with your app name at the repository root.
2. Add a `README.md` inside it (see [Template](#readme-template) below).
3. Add one row to the Applications table in this file.
4. Optionally add GitHub Actions workflows in `.github/workflows/` — they **must** use path filters so they only run when your folder changes:

```yaml
on:
  push:
    branches: [main]
    paths:
      - "your-app-name/**"
  pull_request:
    paths:
      - "your-app-name/**"
```

5. Open a PR and get it merged.

### README template

```markdown
# your-app-name

One-sentence description.

## What it does

...

## Requirements

- Node 20+ / Rust 1.77+ / etc.
- ...

## Building

```bash
# commands to build
```

## Running

```bash
# commands to run
```

## Releasing

Releases are published automatically when a tag matching `your-app-name/v*` is pushed:

```bash
git tag your-app-name/v1.0.0
git push origin your-app-name/v1.0.0
```
```
