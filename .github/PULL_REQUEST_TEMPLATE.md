## Summary

<!-- What does this pull request change, and why? -->

## Related issue

<!-- Closes #... -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Documentation
- [ ] Refactor / internal
- [ ] Build, test or release tooling

## Checklist

- [ ] I read [docs/development.md](docs/development.md) and kept the change in scope.
- [ ] `npm test` passes.
- [ ] `npm run validate` passes.
- [ ] I ran `npm run build` if I changed anything under `src/client/` (and did not hand-edit `client.js`).
- [ ] User-visible behavior or documentation is covered by tests/docs and a `CHANGELOG.md` entry.
- [ ] New or changed UI text goes through the client i18n dictionaries (Chinese and English).
- [ ] No new runtime dependencies, no literal colours, and no `document.body` writes in client sources.
- [ ] Mutations keep the existing safety invariants (revalidation, single write chain, no force-push, commit staged-only).
