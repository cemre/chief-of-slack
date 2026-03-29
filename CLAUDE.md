# Project Rules

## UI Terminology
The user-facing priority sections are:
- **Priority** — urgent + important items (internally: act_now + priority)
- **Relevant** — worth reading when free (internally: when_free)
- **Interesting Elsewhere** — high-engagement messages from the workspace
- **Recent noise** / **Older noise** — low-priority channel messages

Always use these user-facing names in UI text, README, and conversations. The internal category names (act_now, priority, when_free, noise) are for code only.

## Shell Commands
- NEVER prepend `cd "/path/to/project" &&` to shell commands. The working directory is already set to the project folder. Just run commands directly (e.g., `git diff`, not `cd "..." && git diff`).
- NEVER create a `_metadata` folder

## Git
- When asked to commit: immediately stage and commit without asking for confirmation or showing a draft message first.
- For commit messages, use `git commit -m "first line" -m "Co-Authored-By: ..."` instead of HEREDOC/`$(cat <<EOF)` to avoid command substitution permission prompts.
