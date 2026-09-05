import js from "@eslint/js";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist", "node_modules", ".sweep", ".artifacts"] },
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
    // Ordering under src has to be reproducible: the share-link hash, the
    // bisimulation signatures and the render corpus all compare sorted strings
    // across machines, and localeCompare varies with the runtime locale and the
    // ICU build. Sort with < and > instead. Tests are exempt; they compare
    // within one process.
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[property.name='localeCompare']",
          message:
            "localeCompare is locale-dependent; sort with < and > so the order is reproducible.",
        },
      ],
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
