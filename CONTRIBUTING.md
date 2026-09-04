# Contributing

BrowserMatic welcomes issues and pull requests.

## Setup

```bash
pnpm install
pnpm test
pnpm dev
```

`pnpm run deploy` builds and deploys the Worker. Do not run this from a fork — it requires your own Cloudflare account credentials.

## Testing

```bash
pnpm test         # vitest, in-process integration tests
pnpm typecheck    # tsc on both app and worker configs
pnpm build        # vite production build
```

The repo currently has 540 tests. Add a test for any behavior change.

## Pull requests

- One logical change per PR.
- The CI workflow runs `pnpm test && pnpm typecheck && pnpm build`. PRs that don't pass CI won't merge.
- For larger changes, open an issue first to discuss approach.

## Coding conventions

- TypeScript strict mode is on; no `any` without justification.
- Match the existing file structure (`worker/` for the Worker, `src/` for the SPA, `shared/` for code shared between both).
- Don't introduce dependencies without discussion in an issue.
