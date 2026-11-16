# Agent rules

fleet-factory is a software factory on Fleet: a Fleet plugin, a template config and its
apply tooling. Read the design, `docs/design.md`, before a change in its area, and Fleet's
plugin contract before a change to a call, a probe or a plan.

- For an issue, first write an end-to-end test that reproduces it, and see it fail for the
  intended reason. New functionality starts with a failing end-to-end acceptance test.
- Never give estimates of time, effort, or completion.
- Prefer a clear diagram to a long explanation when one fits.
- Check versions in registries, release metadata and lockfiles; never guess. Take the
  latest stable release.
- Write no comments in code. Express intent through names, types, small functions and
  tests. The exceptions are license headers, behaviour forced by an external tool,
  lint suppressions for a faulty rule, tool directives, and public API doc comments.
- Publishing uses the installed `publish` skill and the full repository gate.
- Never change a running Fleet manager, its store, config, credentials or sessions as a
  side effect.
- Never put secrets, client names, private paths, host names or account identities in
  code, fixtures, docs, commit messages or forge comments. Examples use `OWNER`,
  `example.com` and `/ABSOLUTE/PATH`.

## Repository tooling

`prek run --all-files` is the gate, shared by the hooks, the publish skill and CI.
Install the hooks once with `prek install`.
