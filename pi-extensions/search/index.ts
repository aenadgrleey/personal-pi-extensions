import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type ToolName =
  | "grepsearch"
  | "websearch"
  | "codesearch"
  | "context7"
  | "web_fetch";

interface SearchConfig {
  disabledTools?: ToolName[];
}

interface Context7LibraryInfo {
  id: string;
  title: string;
  description?: string;
  totalSnippets?: number;
  benchmarkScore?: number;
}

interface Context7SearchResponse {
  results: Context7LibraryInfo[];
}

interface McpTextBlock {
  type: string;
  text?: string;
}

interface McpJsonResponse {
  result?: {
    content?: McpTextBlock[];
  };
  error?: {
    message?: string;
  };
}

interface GrepsearchParams {
  query: string;
  language?: string;
  repo?: string;
  path?: string;
  limit?: number;
}

interface ParsedGrepBlock {
  repo: string;
  path: string;
  url?: string;
  license?: string;
  snippet: string;
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-search.json");
export const GREP_MCP_URL = "https://mcp.grep.app";
export const GREP_MCP_TOOL = "searchGitHub";
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const CONTEXT7_API = "https://context7.com/api/v2";
const USER_AGENT = "personal-ai-tools-search/1.0";
const MAX_HIGHLIGHTS_CHARS = 500;
const MAX_PAGE_CHARS = 10_000;

type TextToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown> | undefined;
};

const grepsearchParamsSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Code pattern to search for (literal text)",
    },
    language: {
      type: "string",
      description:
        "Filter by language: TypeScript, TSX, Python, Go, Rust, etc.",
    },
    repo: {
      type: "string",
      description: "Filter by repo: 'owner/repo' or partial match",
    },
    path: {
      type: "string",
      description: "Filter by file path: 'src/', '.test.ts', etc.",
    },
    limit: {
      type: "number",
      description: "Max results to return (default: 10, max: 20)",
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

const websearchParamsSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Search query (be specific for better results)",
    },
    numResults: {
      type: "number",
      description: "Number of results (default 8, max 20)",
    },
    type: {
      type: "string",
      description:
        '"auto" (default), "neural" (semantic), or "keyword" (exact match)',
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

const codesearchParamsSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        'Code/API query (e.g. "React useState hook examples", "Go context.WithCancel usage")',
    },
    numResults: {
      type: "number",
      description: "Number of results (default 5, max 10)",
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

const context7ParamsSchema = {
  type: "object",
  properties: {
    operation: {
      type: "string",
      enum: ["resolve", "query"],
      description: 'Operation to perform (default: "resolve")',
    },
    libraryName: {
      type: "string",
      description: "Library name to resolve (for resolve operation)",
    },
    libraryId: {
      type: "string",
      description: "Library ID from resolve (for query operation)",
    },
    topic: {
      type: "string",
      description: "Documentation topic (for query operation)",
    },
    offset: {
      type: "number",
      description:
        "Character offset to start reading from (for paginating long docs)",
      minimum: 0,
    },
  },
  additionalProperties: false,
} as const;

const webFetchParamsSchema = {
  type: "object",
  properties: {
    url: { type: "string", description: "The URL to fetch content from" },
    offset: {
      type: "number",
      description:
        "Character offset to start reading from (for paginating long pages)",
      minimum: 0,
    },
  },
  required: ["url"],
  additionalProperties: false,
} as const;

function loadConfig(): SearchConfig {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as SearchConfig;
    return Array.isArray(raw.disabledTools) ? raw : {};
  } catch {
    return {};
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toolResult(
  text: string,
  details?: Record<string, unknown>,
): TextToolResult {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

function paginateText(
  content: string,
  offset: number,
  maxChars: number,
  header?: string,
): string {
  const clamped = Math.max(0, Math.min(offset, content.length));
  const slice = content.slice(clamped, clamped + maxChars);
  const remaining = content.length - clamped - slice.length;
  let text = header && clamped === 0 ? header + slice : slice;
  if (remaining > 0) {
    text += `\n\n… [${remaining} chars remaining — call again with offset: ${clamped + maxChars} to continue]`;
  }
  return text;
}

function truncateExaResults(raw: string): string {
  const blocks = raw.split("\n---\n");
  const truncated = blocks.map((block) => {
    const idx = block.indexOf("Highlights:\n");
    if (idx === -1) return block;
    const header = block.slice(0, idx + "Highlights:\n".length);
    let highlights = block.slice(idx + "Highlights:\n".length);
    if (highlights.length > MAX_HIGHLIGHTS_CHARS) {
      highlights = `${highlights.slice(0, MAX_HIGHLIGHTS_CHARS).trimEnd()}…`;
    }
    return header + highlights;
  });
  return truncated.join("\n---\n");
}

function extractMcpTextBlocks(parsed: McpJsonResponse): string[] {
  if (parsed.error) {
    throw new Error(
      `MCP error: ${parsed.error.message ?? JSON.stringify(parsed.error)}`,
    );
  }
  return (parsed.result?.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "");
}

function parseMcpResponseText(text: string, contentType: string): string[] {
  if (
    contentType.includes("application/json") ||
    text.trimStart().startsWith("{")
  ) {
    const parsed = JSON.parse(text) as McpJsonResponse;
    return extractMcpTextBlocks(parsed);
  }

  const textBlocks: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    const parsed = JSON.parse(payload) as McpJsonResponse;
    textBlocks.push(...extractMcpTextBlocks(parsed));
  }

  return textBlocks;
}

async function callMcpTool(
  mcpUrl: string,
  toolName: string,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
  timeoutMs = 30_000,
): Promise<string[]> {
  const controller = new AbortController();
  const combinedSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
      signal: combinedSignal,
    });

    if (!response.ok) {
      throw new Error(
        `${toolName} backend returned ${response.status}: ${response.statusText}`,
      );
    }

    const text = await response.text();
    const contentType = response.headers.get("content-type") ?? "";
    const blocks = parseMcpResponseText(text, contentType);
    return blocks.length > 0 ? blocks : [text.slice(0, 5000)];
  } finally {
    clearTimeout(timer);
  }
}

export function buildGrepMcpArguments(
  params: GrepsearchParams,
): Record<string, unknown> {
  const args: Record<string, unknown> = {
    query: params.query,
    matchCase: false,
    matchWholeWords: false,
    useRegexp: false,
  };
  if (params.language) args.language = [params.language];
  if (params.repo) args.repo = params.repo;
  if (params.path) args.path = params.path;
  return args;
}

function parseGrepMcpBlock(block: string): ParsedGrepBlock | undefined {
  const lines = block.trim().split("\n");
  const repo = lines
    .find((line) => line.startsWith("Repository:"))
    ?.slice("Repository:".length)
    .trim();
  const path = lines
    .find((line) => line.startsWith("Path:"))
    ?.slice("Path:".length)
    .trim();
  if (!repo || !path) return undefined;

  const url = lines
    .find((line) => line.startsWith("URL:"))
    ?.slice("URL:".length)
    .trim();
  const license = lines
    .find((line) => line.startsWith("License:"))
    ?.slice("License:".length)
    .trim();
  const snippetsIndex = lines.findIndex((line) => line.trim() === "Snippets:");
  const snippet = (
    snippetsIndex === -1 ? lines : lines.slice(snippetsIndex + 1)
  )
    .join("\n")
    .trim();

  return {
    repo,
    path,
    url,
    license,
    snippet,
  };
}

export function formatGrepMcpBlocks(blocks: string[], limit: number): string {
  const shown = blocks.slice(0, Math.min(limit, 20));
  const formatted = shown.map((block, index) => {
    const parsed = parseGrepMcpBlock(block);
    if (!parsed) {
      return `## ${index + 1}\n\n\`\`\`text\n${block.trim()}\n\`\`\``;
    }

    const lines = [
      `## ${index + 1}. ${parsed.repo}`,
      `**File**: ${parsed.path}`,
    ];
    if (parsed.url) lines.push(`**URL**: ${parsed.url}`);
    if (parsed.license) lines.push(`**License**: ${parsed.license}`);
    lines.push(`\`\`\`text\n${parsed.snippet}\n\`\`\``);
    return lines.join("\n");
  });

  return `Found ${blocks.length} results (showing ${shown.length}):\n\n${formatted.join("\n\n")}`;
}

function context7HttpError(
  status: number,
  operation: string,
  libraryId?: string,
): TextToolResult {
  if (status === 401) {
    return toolResult(
      "Error: Invalid CONTEXT7_API_KEY. Get a free key at https://context7.com/dashboard",
      { operation, error: "auth" },
    );
  }
  if (status === 404 && libraryId) {
    return toolResult(
      `Error: Library not found: ${libraryId}\n\nUse operation: "resolve" first to find the correct ID.`,
      { operation, error: "not_found" },
    );
  }
  if (status === 429) {
    return toolResult(
      "Error: Rate limit exceeded. Get a free API key at https://context7.com/dashboard for higher limits.",
      { operation, error: "rate_limit" },
    );
  }
  return toolResult(`Error: Context7 API returned ${status}`, {
    operation,
    error: `http_${status}`,
  });
}

export default function searchExtension(pi: ExtensionAPI): void {
  const config = loadConfig();
  const disabled = new Set(config.disabledTools ?? []);

  if (!disabled.has("grepsearch")) {
    pi.registerTool({
      name: "grepsearch",
      label: "Grep Search",
      description: `Search real-world code examples from GitHub repositories via Grep MCP.

Use when:
- Implementing unfamiliar APIs - see how others use a library
- Looking for production patterns - find real-world examples
- Understanding library integrations - see how things work together

IMPORTANT: Search for **literal code patterns**, not keywords:
Good: "useState(", "import React from", "async function"
Bad: "react tutorial", "best practices", "how to use"

Examples:
  grepsearch({ query: "getServerSession", language: "TypeScript" })
  grepsearch({ query: "CORS(", language: "Python", repo: "flask" })
  grepsearch({ query: "export async function POST", path: "route.ts" })`,
      promptSnippet:
        "Search real-world code examples from GitHub repos via Grep MCP.",
      parameters: grepsearchParamsSchema,
      async execute(
        _toolCallId,
        params: GrepsearchParams,
        signal,
      ): Promise<TextToolResult> {
        const { query, language, limit = 10 } = params;

        if (!query?.trim()) {
          return toolResult("Error: query is required", {
            error: "query required",
          });
        }

        try {
          const blocks = await callMcpTool(
            GREP_MCP_URL,
            GREP_MCP_TOOL,
            buildGrepMcpArguments(params),
            signal,
            25_000,
          );

          if (blocks.length === 0) {
            return toolResult(
              `No results found for: ${query}${language ? ` (${language})` : ""}`,
              {
                query,
                results: 0,
                backend: "mcp.grep.app",
              },
            );
          }

          return toolResult(formatGrepMcpBlocks(blocks, limit), {
            query,
            language,
            totalResults: blocks.length,
            shown: Math.min(limit, 20, blocks.length),
            backend: "mcp.grep.app",
          });
        } catch (error: unknown) {
          const message = errorMessage(error);
          return toolResult(`Error searching Grep MCP: ${message}`, {
            error: message,
            backend: "mcp.grep.app",
          });
        }
      },
    });
  }

  if (!disabled.has("websearch")) {
    pi.registerTool({
      name: "websearch",
      label: "Web Search",
      description:
        "Search the web using Exa AI. Returns relevant results with content snippets. Use for current information, documentation, blog posts, discussions. No API key required.",
      promptSnippet:
        "Search the web via Exa AI for current information, docs, and discussions.",
      parameters: websearchParamsSchema,
      async execute(
        _toolCallId,
        params: { query: string; numResults?: number; type?: string },
        signal,
      ): Promise<TextToolResult> {
        try {
          const blocks = await callMcpTool(
            EXA_MCP_URL,
            "web_search_exa",
            {
              query: params.query,
              numResults: Math.min(params.numResults ?? 8, 20),
              type: params.type ?? "auto",
              livecrawl: "fallback",
              textContentsOptions: { maxCharacters: 3000 },
            },
            signal,
            25_000,
          );
          return toolResult(truncateExaResults(blocks.join("\n")), {});
        } catch (error: unknown) {
          const message = errorMessage(error);
          return toolResult(`Web search failed: ${message}`, {});
        }
      },
    });
  }

  if (!disabled.has("codesearch")) {
    pi.registerTool({
      name: "codesearch",
      label: "Code Search",
      description:
        "Search for programming documentation, code examples, and API references using Exa AI. Tuned for technical queries and implemented on top of Exa web search because the public MCP endpoint does not currently expose a dedicated code-search tool. No API key required.",
      promptSnippet: "Search technical docs and API references via Exa AI.",
      parameters: codesearchParamsSchema,
      async execute(
        _toolCallId,
        params: { query: string; numResults?: number },
        signal,
      ): Promise<TextToolResult> {
        try {
          const blocks = await callMcpTool(
            EXA_MCP_URL,
            "web_search_exa",
            {
              query: `programming documentation, API reference, code examples, official docs, GitHub examples for: ${params.query}`,
              numResults: Math.min(params.numResults ?? 5, 10),
            },
            signal,
            30_000,
          );
          return toolResult(truncateExaResults(blocks.join("\n")), {
            backend: "web_search_exa",
          });
        } catch (error: unknown) {
          const message = errorMessage(error);
          return toolResult(`Code search failed: ${message}`, {
            backend: "web_search_exa",
          });
        }
      },
    });
  }

  if (!disabled.has("context7")) {
    pi.registerTool({
      name: "context7",
      label: "Context7",
      description: `Context7 documentation lookup: resolve library IDs and query docs.

Operations:
- "resolve": Find library ID from name (e.g., "react" → "/reactjs/react.dev")
- "query": Get documentation for a library topic

Example:
context7({ operation: "resolve", libraryName: "react" })
context7({ operation: "query", libraryId: "/reactjs/react.dev", topic: "hooks" })`,
      promptSnippet:
        "Library documentation lookup — resolve library IDs and query docs.",
      parameters: context7ParamsSchema,
      async execute(
        _toolCallId,
        params: {
          operation?: "resolve" | "query";
          libraryName?: string;
          libraryId?: string;
          topic?: string;
          offset?: number;
        },
        signal,
      ): Promise<TextToolResult> {
        const operation = params.operation ?? "resolve";
        const apiKey = process.env.CONTEXT7_API_KEY;
        const headers: Record<string, string> = {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        };
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

        if (operation === "resolve") {
          const { libraryName } = params;
          if (!libraryName?.trim()) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Error: libraryName is required for resolve operation",
                },
              ],
              details: { operation: "resolve", error: "libraryName required" },
            };
          }

          try {
            const url = new URL(`${CONTEXT7_API}/libs/search`);
            url.searchParams.set("libraryName", libraryName);
            url.searchParams.set("query", "documentation");

            const response = await fetch(url.toString(), { headers, signal });
            if (!response.ok)
              return context7HttpError(response.status, "resolve");

            const data = (await response.json()) as Context7SearchResponse;
            const libraries = data.results ?? [];
            if (libraries.length === 0) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `No libraries found matching: ${libraryName}\n\nTry:\n- Different library name\n- Check spelling\n- Use official package name`,
                  },
                ],
                details: {
                  operation: "resolve",
                  query: libraryName,
                  results: 0,
                },
              };
            }

            const topLibrary = libraries[0];
            if (!topLibrary) {
              return toolResult(`No libraries found matching: ${libraryName}`, {
                operation: "resolve",
                query: libraryName,
                results: 0,
              });
            }

            const formatted = libraries
              .slice(0, 5)
              .map((library, index) => {
                const description = library.description
                  ? `\n   ${library.description.slice(0, 100)}...`
                  : "";
                const snippets = library.totalSnippets
                  ? ` (${library.totalSnippets} snippets)`
                  : "";
                const score = library.benchmarkScore
                  ? ` [score: ${library.benchmarkScore}]`
                  : "";
                return `${index + 1}. **${library.title}** → \`${library.id}\`${snippets}${score}${description}`;
              })
              .join("\n\n");

            return toolResult(
              `Found ${libraries.length} libraries matching "${libraryName}":\n\n${formatted}\n\n**Next step**: Use \`context7({ operation: "query", libraryId: "${topLibrary.id}", topic: "your topic" })\` to fetch documentation.`,
              {
                operation: "resolve",
                query: libraryName,
                results: libraries.length,
                topResult: topLibrary.id,
              },
            );
          } catch (error: unknown) {
            if (error instanceof DOMException && error.name === "AbortError") {
              return {
                content: [
                  { type: "text" as const, text: "Request cancelled." },
                ],
                details: { operation: "resolve", error: "cancelled" },
              };
            }
            const message = errorMessage(error);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error resolving library: ${message}`,
                },
              ],
              details: { operation: "resolve", error: message },
            };
          }
        }

        const { libraryId, topic } = params;
        if (!libraryId?.trim()) {
          return {
            content: [
              {
                type: "text" as const,
                text: 'Error: libraryId is required (use operation: "resolve" first)',
              },
            ],
            details: { operation: "query", error: "libraryId required" },
          };
        }
        if (!topic?.trim()) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: topic is required (e.g., 'hooks', 'setup', 'API reference')",
              },
            ],
            details: { operation: "query", error: "topic required" },
          };
        }

        try {
          const url = new URL(`${CONTEXT7_API}/context`);
          url.searchParams.set("libraryId", libraryId);
          url.searchParams.set("query", topic);

          const response = await fetch(url.toString(), {
            headers: { ...headers, Accept: "text/plain" },
            signal,
          });
          if (!response.ok)
            return context7HttpError(response.status, "query", libraryId);

          const content = await response.text();
          if (!content.trim()) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `No documentation found for "${topic}" in ${libraryId}.\n\nTry:\n- Simpler terms (e.g., "useState" instead of "state management")\n- Different topic spelling\n- Broader topics like "API reference" or "getting started"`,
                },
              ],
              details: { operation: "query", libraryId, topic, results: 0 },
            };
          }

          return {
            content: [
              {
                type: "text" as const,
                text: paginateText(
                  content,
                  params.offset ?? 0,
                  MAX_PAGE_CHARS,
                  `# Documentation: ${topic} (${libraryId})\n\n`,
                ),
              },
            ],
            details: {
              operation: "query",
              libraryId,
              topic,
              length: content.length,
              offset: params.offset ?? 0,
            },
          };
        } catch (error: unknown) {
          if (error instanceof DOMException && error.name === "AbortError") {
            return {
              content: [{ type: "text" as const, text: "Request cancelled." }],
              details: { operation: "query", error: "cancelled" },
            };
          }
          const message = errorMessage(error);
          return {
            content: [
              {
                type: "text" as const,
                text: `Error querying documentation: ${message}`,
              },
            ],
            details: { operation: "query", error: message },
          };
        }
      },
    });
  }

  if (!disabled.has("web_fetch")) {
    pi.registerTool({
      name: "web_fetch",
      label: "Web Fetch",
      description: `Fetch a webpage's content as clean markdown via Exa.

Use after websearch/codesearch when you need the full content of a specific result.
Supports any public URL. Output is truncated to ~10k characters. Use offset to paginate long pages.

Example:
  web_fetch({ url: "https://example.com/article" })
  web_fetch({ url: "https://example.com/article", offset: 20000 })`,
      promptSnippet:
        "Fetch full webpage content as markdown. Use after websearch to read a specific result.",
      parameters: webFetchParamsSchema,
      async execute(
        _toolCallId,
        params: { url: string; offset?: number },
        signal,
      ): Promise<TextToolResult> {
        if (!params.url?.trim()) {
          return toolResult("Error: url is required", {
            error: "url required",
          });
        }

        try {
          const blocks = await callMcpTool(
            EXA_MCP_URL,
            "web_fetch_exa",
            { urls: [params.url] },
            signal,
            30_000,
          );
          return toolResult(
            paginateText(blocks.join("\n"), params.offset ?? 0, MAX_PAGE_CHARS),
            {},
          );
        } catch (error: unknown) {
          const message = errorMessage(error);
          return toolResult(`Fetch failed: ${message}`, {});
        }
      },
    });
  }
}
