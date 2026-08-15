import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // .wt/ は並行開発用の git worktree 置き場。そこにあるテストは各 worktree 内で流す。
    exclude: ['**/node_modules/**', '.wt/**'],
  },
});
