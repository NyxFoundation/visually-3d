"""Authentication is intentionally local-first.

The app uses the user's already-authenticated local `claude` command instead of
accepting or storing Anthropic API keys. Users should authenticate the Claude CLI
outside this app, then start the FastAPI server.
"""

from .analyst import claude_available


def auth_status() -> dict[str, object]:
    return {
        "mode": "local-cli",
        "command": "claude -p",
        "claude_cli_available": claude_available(),
    }
