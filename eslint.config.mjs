import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Pin the React version so eslint-plugin-react skips its filesystem-based
    // auto-detection. Auto-detection calls the legacy context.getFilename()
    // API removed in ESLint 10, crashing with
    // "contextOrFilename.getFilename is not a function" until upstream
    // (jsx-eslint/eslint-plugin-react#3979) ships a fix.
    settings: { react: { version: "19" } },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
