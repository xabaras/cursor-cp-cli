# Changelog

All notable changes to this fork are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.5] — 2026-11-28

### Fixed
- Remove unused imports in `cli-bridge-helpers.test.ts` so the CI lint job passes.

## [0.6.4] — 2026-11-28

### Fixed
- `/cli new`: picking a workspace answered **Invalid selection**. The SDK workspace handler `/ws:(\d+)/` was unanchored and registered first, so it caught `cli:newws:N` and looked in the wrong list. Every callback pattern (`session`, `gh`, `ws`, `q:`) is now anchored, in `CALLBACK_PATTERNS`.

### Changed
- `/cli` and `/cli all` list every chat, 20 per page with **« Prev** / **Next »**, instead of the 25 most recent.
- Chats whose cwd is a temp dir (`os.tmpdir()`, `/tmp`, `/private/var/folders`) are hidden from the list; scripts that run `agent -p` in `mktemp` leave one untitled chat per run.

## [0.6.3] — 2026-11-26

### Added
- `/cli model` — pick Auto or a concrete model for the attached CLI chat (persisted; `agent -p --model` when not Auto).

## [0.6.2] — 2026-11-26

### Changed
- Off-attach completion button label: **Switch to …** (was Italian “Passa a …”), consistent with the English bot UI.

## [0.6.1] — 2026-11-26

### Added
- `/cli cwd` (aliases: `/cli workspace`, `/cli workdir`) to change the workspace of the attached CLI chat for subsequent runs.
- Soft product rebrand to **Telegram Cursor CLI** (display name / npm package `telegram-cursor-cli`; runtime paths and `cursor-cp` command unchanged).
- `CHANGELOG.md` and version / recent-changes section in the README.

### Changed
- README documents parallel CLI jobs, attach switching, and the **Switch to …** completion button.

## [0.6.0] — 2026-11-26

### Added
- Parallel CLI jobs across different chats (FIFO queue per `cliChatId`).
- Stream updates only while that CLI chat is attached; background jobs keep running.
- Off-attach completion message with chat id and **Switch to …** button (re-attaches and re-shows the reply).
- `/cli status` lists active/queued jobs; `/cli cancel` targets the attached chat; `/cli cancel all` stops all jobs for this Telegram chat.

### Changed
- Default `cli_bridge.timeout_ms` is `0` (no hard kill). Long runs no longer hit “CLI run timed out…”.

## [0.5.4] — 2026-11

### Fixed
- Incomplete CLI replies: prefer the longer of stream vs result text; send the final message before deleting the stream preview.

## [0.5.3] — 2026-11

### Added
- `notify_on_complete` (default `true`): delete the stream preview and `sendMessage` so Telegram can fire an OS notification.

## [0.5.2] — 2026-11

### Fixed
- Duplicate Telegram CLI replies when `editMessageText` returns “message is not modified”.

## [0.5.1] — 2026-11

### Changed
- Product naming pass for the fork (display as Cursor Control Plane + CLI at the time).

## [0.5.0] — 2026-11

### Added
- First `cursor-cp-cli` fork release: Telegram bridge to local Cursor CLI chats via `agent -p --resume`, plus upstream web dashboard / SDK sessions.
