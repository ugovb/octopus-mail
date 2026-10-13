# Security

Octopus Mail stores mail passwords and OAuth tokens, so security reports are very welcome.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting instead:
**Security → Report a vulnerability** on this repository. Include the version, your OS,
steps to reproduce and what an attacker could gain. You will get an answer within a few days.

## How credentials are kept

- **Desktop app:** passwords and tokens live in the operating system's secret store
  (Windows Credential Manager, macOS Keychain, GNOME Keyring / KWallet), never in the database.
  Linux machines without a Secret Service fall back to a file readable only by the owner.
- **Home server (`octo serve`):** passwords are kept in `secrets.json` in the server user's data
  directory (mode 0600). Devices pair with a one-time code (valid 15 minutes) and get their own
  token; only a SHA-256 hash of each token is stored, and any device can be revoked.
- The home server speaks plain HTTP and is meant for a home network. Reach it from outside
  through a VPN (Tailscale, WireGuard), **not** through a port forwarded on your router.
- AI features use a local Ollama model by default. Mail content goes to Anthropic only if you
  add your own Claude API key and use an AI action.
