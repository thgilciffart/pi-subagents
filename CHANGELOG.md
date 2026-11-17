# Changelog

## [0.1.2](https://github.com/thgilciffart/pi-subagents/compare/v0.1.1...v0.1.2) (2026-11-17)


### Fixes

* **ci:** automate version bumps and release notes ([fd5c900](https://github.com/thgilciffart/pi-subagents/commit/fd5c9005946b4106d0194e2724d283500ad1fd8a))

## 0.1.1

- Store subagent runtime data beside its parent session in `<session ID>.subagents/`.
- Store global settings in `~/.pi/agent/subagent.json`.
- Migrate existing runtime data and settings when the parent session opens.
- Install npm 11 in the publishing workflow to support trusted publishing.
