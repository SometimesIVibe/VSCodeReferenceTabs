import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  files: "out-test/test/**/*.test.js",
  workspaceFolder: "src/test/fixture",
  version: "stable",
  mocha: {
    timeout: 30000,
  },
});
