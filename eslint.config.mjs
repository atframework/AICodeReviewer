import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/.venv/**",
      "**/coverage/**",
      "**/dist/**",
      "**/node_modules/**",
      "build/**",
      ".kilo/**",
      "workspaces/**",
      "deploy/**",
      // The docs site (docs/site) is an isolated Astro Starlight app with its
      // own tsconfig and `astro check`; it is not runtime code and is excluded
      // from the runtime Docker image. Do not lint it with the runtime config.
      "docs/site/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.mts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.es2024,
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    // Dashboard browser client (P6): plain ESM served verbatim to the
    // browser; no Node APIs, DOM globals only.
    files: ["packages/server/src/dashboard/client/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
      },
    },
  },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // CommonJS build scripts (e.g. packages/server/scripts/copy-assets.cjs).
    files: ["**/*.cjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
