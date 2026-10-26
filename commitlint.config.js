export default {
  extends: ["@commitlint/config-conventional"],
  // Changesets' release PR commits ("Version Packages") are not conventional commits.
  ignores: [(message) => /^Version Packages\b/.test(message)],
  rules: {
    "header-max-length": [2, "always", 72],
    // Subjects are sentence case, e.g. "feat: Add draft PR support".
    "subject-case": [2, "always", ["sentence-case"]],
  },
};
