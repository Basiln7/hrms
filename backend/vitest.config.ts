import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every API test file starts the app on a throwaway database of its own: creating it, all
    // its indexes and the sample company. With all the files starting together that takes
    // longer than Vitest's default ten seconds on an ordinary machine.
    hookTimeout: 60_000,
    // A test that walks a week of punches makes dozens of requests: give it room on a busy machine.
    testTimeout: 20_000,
  },
});
