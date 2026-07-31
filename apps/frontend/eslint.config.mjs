import { nextJsConfig } from "@repo/eslint-config/next-js";

export default [
  ...nextJsConfig,
  {
    ignores: [".next/**", "out/**", "build/**", "next-env.d.ts"],
  },
];
