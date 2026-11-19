# A fleet-factory config

Copy this directory into a private repository of your own. It describes one software
factory: the board it reads, the repositories it builds, the Fleet TaskConfigs each stage
runs with, and the policy. [The design](https://github.com/Thurbeen/fleet-factory/blob/main/docs/design.md)
explains each stage and gate.

## Prerequisites

- Node.js 22.18 or later. The plugin runs unbuilt from a checkout of fleet-factory, with no
  `pnpm install`.
- A `fleet` binary from [Thurbeen/thurbox](https://github.com/Thurbeen/thurbox/releases)
  v3.1.0 or later.
- A checkout of fleet-reviewer that knows `forge.login`.
- `gh`, which the sessions and Fleet's forge host run.
- Two GitHub Apps on the target repository: an author App that can write contents, issues
  and pull requests, and a reviewer App that can write pull requests.

## Fill it

1. Edit `factory.json`. Every secret is a reference, `{"secret": "NAME"}`, never a value.

2. Create two GitHub Apps and install each on the target repository. The author App, with
   write access to contents, issues and pull requests, serves the board, the merge gate,
   Fleet's reads of each change, and the refine, build and watch sessions. The reviewer App,
   with write access to pull requests, reviews and approves. GitHub never counts an approval
   by a change's author, so `factory plan` refuses one identity on both sides.

3. Copy `factory.local.example.json` to `factory.local.json`, which git ignores. It holds what
   differs per machine: the `fleet` binary, the fleet-reviewer checkout, the Fleet runtime,
   and the source of each secret with absolute paths. A `githubApp` source names an App, its
   installation and its private key file, and the factory mints a fresh token for each use.
   A `command` or `file` source, such as a personal token, still works; see [Secrets](#secrets)
   and [the design](https://github.com/Thurbeen/fleet-factory/blob/main/docs/design.md#the-factorys-identities).

4. Set `stages.review.login` to the reviewer App's login, `APP_SLUG[bot]`.

5. On the target repository, require a pull request with one approval, resolved threads and
   status checks, and allow auto-merge. The factory starts no build until it reads these
   rules. Give the reviewer App Contents write on the repository, next to its Pull requests
   access, so GitHub counts its approval. Until
   [fleet-reviewer#15](https://github.com/Thurbeen/fleet-reviewer/issues/15) ships, a person
   resolves each reviewer thread before the change can merge. Once it ships, the reviewer
   resolves its own fixed threads, which GitHub allows only with write access to the
   repository; see [Resolving its threads](https://github.com/Thurbeen/fleet-factory/blob/main/docs/design.md#resolving-its-threads).

6. Create the three labels a person sets:

   ```sh
   gh label create factory -R OWNER/app
   gh label create factory:ready -R OWNER/app
   gh label create factory:hold -R OWNER/app
   ```

### Secrets

| Secret | Used by |
| --- | --- |
| `author-app` | The plugin, as its board and forge token; Fleet's forge host; the refine, build and watch sessions' `gh` and `git push` |
| `reviewer-app` | fleet-reviewer and the review session |
| `observability-token` | The watch TaskConfig, `factory-watch` |

`as` names the environment variable a source sets. Every secret needs `as`, except a `file`
source that only a TaskConfig reads.

### Labels

| Label | Set by | Effect |
| --- | --- | --- |
| `factory` | A person | Puts the ticket into the factory; `board.intakeLabel` |
| `factory:ready` | A person | Starts the build when `policy.buildGate` is `label` |
| `factory:hold` | A person | On the issue, stops the auto-merge request; `merge.holdLabel` |
| `factory:needs-decision` | The plugin | A question on the ticket waits for a person |
| `factory:refined` | The plugin | The decisions are on the ticket and no question is open |
| `factory:proposed` | The plugin | A follow-up ticket from a watch finding; `policy.followUps.label` |
| `factory:regression`, `factory:improvement` | The plugin | The kind of watch finding behind a follow-up ticket |

GitHub creates a missing label when the plugin adds it, so only the first three need setting up.

## Run it

From this directory, with a checkout of fleet-factory at `FACTORY`:

```sh
node FACTORY/bin/factory.ts plan    # what would change; writes nothing
node FACTORY/bin/factory.ts apply   # writes .fleet/fleet.toml and the Fleet resources
node FACTORY/bin/factory.ts up      # runs fleet up on that config, with telemetry export
```

`apply` is idempotent: a second run prints `nothing to change`. The factory runs on its own
Fleet config, `.fleet/fleet.toml`, and data directory under `.fleet/`, so an existing Fleet
config stays untouched.

To run on an engine you already run, set `fleetConfig` in `factory.local.json` to its config
file's absolute path. `plan` then prints the plugin entries that config needs, and, with an
author App, the `[forge.hosts]` line that runs Fleet's `gh` as that App. Add them yourself
and restart that engine; `apply` refuses until they are there, and never writes
that config. Run `up` only without `fleetConfig`.

## Put a ticket through

[The loop](https://github.com/Thurbeen/fleet-factory/blob/main/docs/design.md#the-loop)
describes each stage. A person:

1. Labels the issue `factory`.
2. Answers each question the factory posts on it, in a comment of their own with no worker
   mark. Only a `User` account with write access decides a human-owned area.
3. Sets `factory:ready` to start the build.
4. Waits for the forge to merge the factory's change. To stop it, set `factory:hold` on the
   issue before fleet-reviewer approves; after that, disable auto-merge on the pull request.
