# Changelog

All notable changes to this fork are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.1] — 2026-11-26

### Added
- `/cli cwd` (aliases: `/cli workspace`, `/cli workdir`) to change the workspace of the attached CLI chat for subsequent runs.
- Soft product rebrand to **Telegram Cursor CLI** (display name / npm package `telegram-cursor-cli`; runtime paths and `cursor-cp` command unchanged).
- `CHANGELOG.md` and version / recent-changes section in the README.

### Changed
- README documents parallel CLI jobs, attach switching, and the **Passa a …** completion button.

## [0.6.0] — 2026-11-26

### Added
- Parallel CLI jobs across different chats (FIFO queue per `cliChatId`).
- Stream updates only while that CLI chat is attached; background jobs keep running.
- Off-attach completion message with chat id and **Passa a …** button (re-attaches and re-shows the reply).
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
