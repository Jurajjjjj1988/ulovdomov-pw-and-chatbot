// ESLint flat config — chatbot module (TypeScript strict).
//
// Mirrors the conventions of the Playwright module's eslint config but
// drops the Playwright plugin (this module doesn't run Playwright tests)
// and adds rules tuned for LLM agent code: no unused vars, strict null
// checks via TypeScript, no console.log in shipped code (the CLI is the
// only allowed console caller, marked with eslint-disable-next-line).

import tseslint from "typescript-eslint";
import js from "@eslint/js";

export default tseslint.config(
  {
    ignores: ["node_modules/**", "dist/**", "logs/**", "knowledge-base/.index.json"],
  },
  {
    files: ["src/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Type safety
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // Code style
      "no-console": ["warn", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "always"],
      curly: ["error", "multi-line"],
    },
  },
  {
    // CLI and analyzer entry points legitimately use console.log to talk to
    // the user. Allow it explicitly here rather than salting the code with
    // eslint-disable-next-line comments.
    files: ["src/cli.ts", "src/conversation-log-analyzer.ts", "src/eval/**/*.ts", "src/rag/ingest.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    files: ["src/**/*.test.ts"],
    rules: {
      // Vitest's `expect()` returns a chainable Assertion — passing it to
      // floating-promises trips a false positive.
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
);
