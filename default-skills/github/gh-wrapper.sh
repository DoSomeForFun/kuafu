#!/bin/bash
set -e
subcmd=$1
shift
case $subcmd in
  login)
    gh auth login "$@"
    ;;
  clone)
    gh repo clone "$@"
    ;;
  pull)
    gh repo sync "$@"
    ;;
  push)
    git push "$@"
    ;;
  checkout)
    git checkout "$@"
    ;;
  commit)
    git commit "$@"
    ;;
  pr-create)
    gh pr create "$@"
    ;;
  pr-merge)
    gh pr merge "$@"
    ;;
  pr-checkout)
    gh pr checkout "$@"
    ;;
  issue-list)
    gh issue list "$@"
    ;;
  issue-view)
    gh issue view "$@"
    ;;
  issue-close)
    gh issue close "$@"
    ;;
  *)
    echo "Unknown or unsupported subcommand: $subcmd"
    exit 1
    ;;
esac
