---
name: linear-cli
description: Create, list, and complete Linear issues for explicit task tracking requests in Slack.
---

# linear-cli

Reference note: the runtime now exposes dedicated `linear_*` custom tools for these operations.
Keep this file as behavioral documentation and as a fallback reference for the equivalent CLI workflows.

Typical triggers:

- "タスク追加して"
- "タスク確認して"
- "完了にして"
- "issue 作って"
- "チケット切って"
- "create a Linear issue"
- "list active tasks"
- "mark this done"

Do not use this skill for normal conversation.

## Environment

- `linear` is already on `PATH`
- `LINEAR_API_KEY` is already configured
- `LINEAR_TEAM_KEY` is fixed by the environment
- `LINEAR_WORKSPACE` is informational only when `LINEAR_API_KEY` is set

Important:

- When `LINEAR_API_KEY` is set, do not add `-w` or `--workspace` to raw `linear` commands.
- Use the bundled scripts below instead of rebuilding long CLI invocations from scratch.

## Supported Workflows

### Create an issue

1. Extract a concise issue title.
2. Write a short markdown description file with the Slack context.
3. Run:

```bash
desc_file=$(mktemp)
cat >"$desc_file" <<'EOF'
# Summary
- ...

# Context
- ...
EOF

scripts/create-issue.sh --title "Replace me" --description-file "$desc_file"
rm -f "$desc_file"
```

4. Reply with the created issue ID and URL.

If the create output does not contain a URL, run:

```bash
linear issue url ISSUE-123
```

### List active tasks

Use:

```bash
scripts/list-active.sh --limit 20
```

Summarize briefly with `ID / title / state`.

### Mark an issue complete

If the issue ID is known, run:

```bash
scripts/complete-issue.sh ISSUE-123
```

If the issue is ambiguous, first inspect active tasks and ask one concise follow-up question.

## Guardrails

- Linear is the only system of record for tracked tasks.
- Do not invent or use any internal todo system.
- Do not ask the user for API keys.
- If the request is too vague to create the right issue, ask one concise follow-up and stop there.
