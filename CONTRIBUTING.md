# Contributing

Thank you for improving 飨拓™库存管理.

## License of contributions

Unless explicitly agreed otherwise in writing, every contribution submitted
for inclusion in this repository is provided under `AGPL-3.0-only`, the same
license as the project code. By submitting a contribution, you confirm that
you have the right to provide it under those terms.

The project name and logo are governed separately by `TRADEMARKS.md`.
Contributing code does not grant permission to use the Brand Assets for a fork
or independent service.

## Before opening a change

- Do not include production databases, customer data, PINs, tokens, signing
  keys, recovery passphrases, `.env` files, or private network credentials.
- Keep API behavior consistent across the Python and Rust backends.
- Add or update tests for behavior changes.
- Keep migrations compatible with both Alembic and the Rust embedded migration
  runner.
- Preserve third-party copyright and license notices.

Run the local checks before opening a pull request:

```bash
./scripts/check-licenses.sh
SKIP_ANDROID=1 ./scripts/verify.sh
```

Android release changes additionally require the signed APK verification gate
documented in `android/README.md`.

## Commit scope

Keep commits focused and explain user-visible behavior, migration impact, and
verification results in the pull request. Never rewrite or remove unrelated
work from a contributor’s branch.
