# Contributing to Minions

Thanks for helping. Minions is a password manager, so correctness and security come
first; small, focused pull requests with tests are the easiest to review.

## Ways to help

- **Report a bug** or **suggest a feature** with the [issue templates](https://github.com/shimentosh/minions/issues/new/choose).
- **Fix an issue.** Issues labelled `good first issue` are a good start.
- **Improve the docs**, screenshots or translations.
- **Security research.** Report vulnerabilities privately; see [the security policy](.github/SECURITY.md).

## Set up

Follow [Quick start](README.md#quick-start). In short:

```bash
pnpm install
pnpm db:up && pnpm mail:up
cp apps/api/.env.example apps/api/.env   # fill SERVER_ENCRYPTION_KEY and PRELOGIN_SECRET
cp apps/web/.env.example apps/web/.env
pnpm --filter @minions/core build
pnpm --filter @minions/api db:deploy
pnpm dev
```

Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing anything that touches keys,
encryption, sessions or sharing.

## Workflow

`main` is protected: every change goes through a pull request.

1. Fork the repo and create a branch from `main` (`fix/…`, `feat/…`, `docs/…`).
2. Make the change, with tests.
3. Run the checks:

   ```bash
   pnpm typecheck
   pnpm lint                      # pnpm lint:fix formats with Biome
   pnpm --filter @minions/core test
   pnpm --filter @minions/api test
   node tests/e2e/smoke.mjs       # with pnpm dev running, for UI changes
   ```

4. Open a pull request and fill in the template. Add screenshots for UI changes.

## Ground rules for security-sensitive code

- **Never** send a secret, the master password or a key to the server, logs, URLs,
  error messages, analytics or the AI. Secrets travel only as encrypted envelopes.
- Every database query must be scoped to the caller's vault or user.
- New sensitive item fields must be marked `sensitive: true` in
  `packages/core/src/item-types.ts`, so the API rejects them in plaintext.
- If you change what the server can see, update [ARCHITECTURE.md](ARCHITECTURE.md),
  [SECURITY.md](SECURITY.md) and [THREAT_MODEL.md](THREAT_MODEL.md) in the same pull request.
- No new dependency in `packages/core` without a strong reason; it runs in every app.

## Style

- TypeScript everywhere; formatting and linting by [Biome](https://biomejs.dev) (`pnpm lint`).
- Match the surrounding code: naming, comment density, component patterns.
- UI copy is short, plain and specific.

## License

By contributing, you agree that your contributions are licensed under the
[AGPL-3.0](LICENSE), the license of this project.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).
