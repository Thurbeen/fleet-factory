# A fleet-factory config

Copy this directory into a private repository of your own. It describes one software
factory: the board it reads, the repositories it builds, the Fleet TaskConfigs each stage
runs with, and the policy. [The design](https://github.com/Thurbeen/fleet-factory/blob/main/docs/design.md)
explains each stage and gate.

## Fill it

1. Edit `factory.json`. Every secret is a reference, `{"secret": "NAME"}`, never a value.
2. Copy `factory.local.example.json` to `factory.local.json`, which git ignores. It holds what
   differs per machine: the `fleet` binary, the fleet-reviewer checkout, the Fleet runtime,
   and the source of each secret, a file or a command with absolute paths. For a GitHub App
   as the reviewer, use a `githubApp` source; see [the design](https://github.com/Thurbeen/fleet-factory/blob/main/docs/design.md#a-github-app-as-the-reviewer).
3. On the target repository, require a pull request with one approval, resolved threads and
   status checks, and allow auto-merge. The factory starts no build until it reads these
   rules.

## Run it

From this directory, with a checkout of fleet-factory at `FACTORY`:

```sh
node FACTORY/bin/factory.ts plan    # what would change; writes nothing
node FACTORY/bin/factory.ts apply   # writes .fleet/fleet.toml and the Fleet resources
node FACTORY/bin/factory.ts up      # runs fleet up on that config, with telemetry export
```

`apply` is idempotent: a second run prints `nothing to change`. The factory runs on its own
Fleet config and data directory under `.fleet/`, so an existing Fleet config stays untouched.
