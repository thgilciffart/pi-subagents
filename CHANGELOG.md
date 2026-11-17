# Changelog

## 0.1.1

- Store subagent runtime data beside its parent session in `<session ID>.subagents/`.
- Store global settings in `~/.pi/agent/subagent.json`.
- Migrate existing runtime data and settings when the parent session opens.
- Install npm 11 in the publishing workflow to support trusted publishing.
