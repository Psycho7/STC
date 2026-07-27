import js from "@eslint/js";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist", "node_modules", ".sweep"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}", "test/**/*.{ts,tsx}"],
    plugins: { react, "react-hooks": reactHooks },
    settings: { react: { version: "detect" } },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...react.configs.flat["jsx-runtime"].rules,
      ...reactHooks.configs.flat["recommended-latest"].rules,
    },
  },
  {
    // Workflow scripts are not modules: the Workflow runtime evaluates them with
    // `args`, `agent`, `pipeline`, `parallel`, `phase`, `log`, `budget` and
    // `workflow` already bound in scope, so there is nothing to import and
    // no-undef has no way to know they exist.
    files: [".claude/workflows/*.js"],
    languageOptions: {
      globals: {
        agent: "readonly",
        args: "readonly",
        budget: "readonly",
        log: "readonly",
        parallel: "readonly",
        phase: "readonly",
        pipeline: "readonly",
        workflow: "readonly",
      },
    },
  },
);
