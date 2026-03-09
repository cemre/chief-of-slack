# Project Rules

## Shell Commands
- NEVER prepend `cd "/path/to/project" &&` to shell commands. The working directory is already set to the project folder. Just run commands directly (e.g., `git diff`, not `cd "..." && git diff`).
- NEVER create a `_metadata` folder

## Git
- When asked to commit: immediately stage and commit without asking for confirmation or showing a draft message first.
- For commit messages, use `git commit -m "first line" -m "Co-Authored-By: ..."` instead of HEREDOC/`$(cat <<EOF)` to avoid command substitution permission prompts.
