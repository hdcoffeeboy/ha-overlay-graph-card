import { readFileSync } from "node:fs";
import resolve from "@rollup/plugin-node-resolve";
import replace from "@rollup/plugin-replace";
import terser from "@rollup/plugin-terser";

const pkg = JSON.parse(readFileSync("./package.json", "utf8"));

export default {
  input: "src/overlay-graph-card.js",
  output: {
    file: "dist/overlay-graph-card.js",
    format: "es",
    sourcemap: false,
  },
  plugins: [
    replace({
      preventAssignment: true,
      values: { __CARD_VERSION__: JSON.stringify(pkg.version) },
    }),
    resolve({ browser: true }),
    terser({ format: { comments: false } }),
  ],
};
