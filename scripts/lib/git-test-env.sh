# Sourced by shell tests that run Git, or a script that calls it, in a temporary
# repository. A Git hook or `git rebase --exec` run from a linked worktree exports
# GIT_DIR. Inherited, it sends `git init`, `git add` and `git config` to the real
# repository, where `git init` sets core.bare in the shared config.
# test/support/git-env.ts is the same thing for TypeScript tests.

for inherited_git_variable in "${!GIT_@}"; do
  unset "${inherited_git_variable}"
done
unset inherited_git_variable

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
