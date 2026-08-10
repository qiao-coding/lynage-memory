// ---------------------------------------------------------------------------
// ESLint flat config (ESLint 9 + typescript-eslint)
// ---------------------------------------------------------------------------

import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.git/**",
      "**/*.config.js",
      "**/*.config.mjs",
      "**/*.config.ts",
      "**/coverage/**",
      "**/data/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    // Benchmarks are experiment/diagnostic scripts — keep unused debug variables.
    files: ["benchmarks/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/consistent-type-imports": "off",
      "prefer-const": "off",
    },
  },
);
