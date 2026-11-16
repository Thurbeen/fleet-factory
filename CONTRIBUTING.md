# Contributing

Read [AGENTS.md](AGENTS.md) and the design, `docs/design.md`, first.

## Setup

```sh
prek install
```

[prek](https://github.com/j178/prek) runs the hooks;
[cocogitto](https://github.com/cocogitto/cocogitto) checks commit messages.

## The gate

`prek run --all-files` is the gate: gitleaks, rumdl and ShellCheck. The `publish` skill
and CI run the same checks.

## Commits and pull requests

- Commits follow [Conventional Commits](https://www.conventionalcommits.org/), with the
  types in `cog.toml`. The `commit-msg` hook runs `cog verify`.
- Pull requests are squash merged. The title becomes the commit on `main`, so the
  `PR Title` check validates it.
