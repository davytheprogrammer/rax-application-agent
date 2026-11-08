# Contributing

Rax is open to focused fixes for browser reliability, application workflows, accessibility, security boundaries, and Linux desktop UX.

1. Open an issue describing the user-visible failure or proposed behavior. Include a small reproducible example when possible.
2. Keep changes scoped. New application-specific logic should still support jobs, grants, fellowships, scholarships, and other forms.
3. Run `npm run test:local` before a pull request when your environment supports Chrome and Electron. The suite uses a local fake model endpoint and controlled pages; real-site behavior needs separate evidence.
4. Describe what changed, how you checked it, and any remaining limitation in the pull request.

Never commit `.env`, API keys, browser profiles, real application records, resumes, or screenshots with personal data. Use synthetic fixtures and label demo screenshots honestly. Read [security notes](docs/SECURITY.md) before changing file, shell, upload, or submission behavior.

By contributing, you agree that your contribution is licensed under the repository's MIT license.
