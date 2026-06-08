import assert from "node:assert/strict";

import {
  GREP_MCP_TOOL,
  GREP_MCP_URL,
  buildGrepMcpArguments,
  formatGrepMcpBlocks,
} from "./index.ts";

assert.equal(GREP_MCP_URL, "https://mcp.grep.app");
assert.equal(GREP_MCP_TOOL, "searchGitHub");

assert.deepEqual(
  buildGrepMcpArguments({
    query: "useState(",
    language: "TypeScript",
    repo: "facebook/react",
    path: "src/",
    limit: 3,
  }),
  {
    query: "useState(",
    language: ["TypeScript"],
    repo: "facebook/react",
    path: "src/",
    matchCase: false,
    matchWholeWords: false,
    useRegexp: false,
  },
);

const formatted = formatGrepMcpBlocks(
  [
    `Repository: foo/bar
Path: src/index.ts
URL: https://github.com/foo/bar/blob/main/src/index.ts
License: MIT

Snippets:
--- Snippet 1 (Line 10) ---
const [count, setCount] = useState(0);
setCount(count + 1);
`,
  ],
  1,
);

assert.match(formatted, /^Found 1 results \(showing 1\):/);
assert.match(formatted, /## 1\. foo\/bar/);
assert.match(formatted, /\*\*File\*\*: src\/index\.ts/);
assert.match(
  formatted,
  /\*\*URL\*\*: https:\/\/github\.com\/foo\/bar\/blob\/main\/src\/index\.ts/,
);
assert.match(formatted, /const \[count, setCount\] = useState\(0\);/);

console.log("search tests passed");
