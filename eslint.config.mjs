import s2script from "@s2script/eslint-plugin";

// The SAME pinned rules `s2s build` enforces — the editor's ESLint extension picks this up,
// so a violation is a red squiggle before you ever build (green editor => green build).
// Test/config files are excluded from the plugin build (tsconfig includes only `src`) and run on
// Node via vitest, where newer-than-ES2020 APIs are allowed — so they are outside the plugin lint.
export default [
  { ignores: ["test/**", "vitest.config.ts"] },
  ...s2script.configs.recommended({ tsconfigRootDir: import.meta.dirname }),
];
