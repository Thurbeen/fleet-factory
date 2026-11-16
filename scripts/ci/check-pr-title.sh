#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
    printf 'usage: %s <title> <pr-number>\n' "${0##*/}" >&2
    exit 2
fi

title="$1"
number="$2"

if [ -z "$title" ]; then
    printf 'The pull request title is empty.\n' >&2
    exit 1
fi

if printf '%s' "$title" | grep -qE '[[:space:]]\(#[0-9]+\)[[:space:]]*$'; then
    printf 'The title already ends in a (#N) reference; squash merge appends " (#%s)" itself.\n' \
        "$number" >&2
    exit 1
fi

# cog verify panics without a git identity, which a fresh CI checkout lacks.
if ! git config --get user.name >/dev/null 2>&1 ||
    ! git config --get user.email >/dev/null 2>&1; then
    borrowed_home=$(mktemp -d)
    trap 'rm -rf "$borrowed_home"' EXIT
    printf '[user]\n\tname = pr title checker\n\temail = checker@invalid\n' \
        >"$borrowed_home/.gitconfig"
    export HOME="$borrowed_home"
fi

subject="$title (#$number)"

if ! report=$(printf '%s\n' "$subject" | cog verify --file - 2>&1); then
    printf 'The pull request title is not a conventional commit.\n\n  lands as: %s\n\n%s\n' \
        "$subject" "$report" >&2
    printf '\nAllowed types are the [commit_types] keys in cog.toml.\n' >&2
    exit 1
fi

printf 'Pull request title lands as a conventional commit: %s\n' "$subject"
