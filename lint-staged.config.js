export default {
  "*.{ts,js,mjs,cjs}": ["eslint --fix", "prettier --write"],
  "!(*.{ts,js,mjs,cjs})": "prettier --write --ignore-unknown",
};
