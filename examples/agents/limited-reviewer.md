---
name: limited-reviewer
description: Review assigned files with an explicit read-only allowlist.
trust: untrusted
permissions: read-only
tools: [read, grep, find, ls]
---
Review the assigned files. Return actionable findings with file references. Return questions to the parent.
