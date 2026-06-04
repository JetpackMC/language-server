## Project Overview

Jetpack Language Support is a TypeScript-based VS Code extension and language server for Jetpack `.jet` scripts. It provides syntax highlighting, static diagnostics, completion, navigation, rename support, semantic tokens, and document symbols.

Before starting work, inspect the relevant implementation first and understand how the current language-server flow works before making changes. If requirements or behavior are unclear, ask a specific question instead of guessing.

## Working Principles

- Keep changes small and clearly scoped.
- Prefer the existing structure and code style.
- Be especially careful with changes that affect broad areas such as lexing, parsing, name resolution, type checking, import resolution, or LSP feature behavior.
- Consider compatibility impact when changing language behavior, diagnostics, settings, package metadata, or VSIX packaging.
- Avoid unnecessary large refactors or new abstractions.
- Do not revert existing user changes.

## Code Guidelines

- Use clear names and keep control flow simple.
- Catch exceptions only when there is meaningful handling. Do not hide failures; preserve enough context to understand the cause.
- Code with many comments is often not a sign of good code. Well-written code should be understandable without relying on comments.
- If explanatory comments are frequently needed, that may indicate the code structure should be improved. In that case, refine the structure first; when comments are truly necessary, explain why something is done rather than what the code is doing.
- When changing LSP features, consider partial or invalid source files because users edit code while the server is running.
- When changing packaging, make sure runtime files required by the extension are included and generated artifacts are not committed.

## Language-Server-Specific Notes

- Keep lexer, parser, resolver, checker, and symbol index behavior consistent with the Jetpack language runtime.
- Keep diagnostics useful for script authors and avoid noisy or misleading messages.
- When changing completion, hover, definition, references, rename, or semantic tokens, consider both local scope and workspace/module behavior.
- Keep `using` resolution compatible with the configured scripts root and manifest-based fallback.
- Do not edit generated outputs or build artifacts as if they were source files.

## Collaboration

- Summarize the change scope and verification status when work is complete.
- Clearly state anything that was not verified.
- Create commits only when explicitly requested by the user.
- Follow the repository's contributing document for contribution flow, branches, commits, and PRs.
