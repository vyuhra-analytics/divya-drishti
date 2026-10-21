// Divya Drishti MCP server over stdio: `bun run --cwd apps/drishti-mcp start` (see CLAUDE.md for the Claude Code / Claude Desktop config).
// stdout belongs to the protocol: anything for a human goes to stderr.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { configFromEnv, createServer } from "./server";

const cfg = configFromEnv();
const server = createServer(cfg);
await server.connect(new StdioServerTransport());
console.error(`divya-drishti MCP ready: stream ${cfg.stream}, api ${cfg.api}, paper account "${cfg.account}", paper writes ${cfg.write ? "ENABLED" : "off (set MCP_PAPER_WRITE=1 to allow simulated trades)"}`);
