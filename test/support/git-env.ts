/**
 * An environment for running Git, or a script that calls it, in a temporary
 * repository. A Git hook or `git rebase --exec` run from a linked worktree
 * exports GIT_DIR. Inherited, it sends `git init`, `git add` and `git config` to
 * the real repository, where `git init` sets core.bare in the shared config.
 * scripts/lib/git-test-env.sh is the same thing for shell tests.
 */
export function isolatedGitEnv(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
    ),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}
