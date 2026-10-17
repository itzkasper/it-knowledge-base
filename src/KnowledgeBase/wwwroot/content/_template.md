---
title: Short, action-shaped title
category: SOPs
tags: [example, template]
updated: 2026-10-17
owner: Service Desk
---

> Files whose name starts with an underscore are skipped by the index builder,
> so this template never shows up in the knowledge base. Copy it to start a new
> document.

## Purpose

One or two sentences on what this procedure achieves and when to use it.

## Before you start

- Access or permissions required
- Tools needed
- Anything that must be true first

> [!WARNING]
> Call out anything destructive or hard to reverse here.

## Procedure

1. First step, written as an instruction.
2. Second step.
   - A sub-point that clarifies the step
3. Third step.

```powershell
# Commands go in fenced blocks with a language tag.
Get-Service -Name "Spooler" | Select-Object Status, Name
```

## Verification

How to confirm the procedure worked.

| Check | Expected result |
|-------|-----------------|
| Service state | Running |
| Event log | No new errors |

## Rollback

How to undo this if it goes wrong.

## Related

- [Another document](#/sops/another-document)
