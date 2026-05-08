#!/usr/bin/env node
/**
 * mcp-cache - Universal caching proxy for any MCP server
 *
 * Usage:
 *   mcp-cache [options] <command> [args...]
 *
 * Options:
 *   --session <id>       Attach to an existing session ID
 *   --fork-from <id>     Fork from an existing session (inherits its cache)
 *   --label <name>       Human-readable label for this session
 *
 * Environment variables:
 *   MCP_CACHE_SESSION_ID   Same as --session
 *   MCP_CACHE_FORK_FROM    Same as --fork-from
 *   MCP_CACHE_SESSION_LABEL Same as --label
 *   MCP_CACHE_TTL          Default TTL in seconds (default: 3600)
 *   MCP_CACHE_TOOL_TTLS    Per-tool TTLs: "read_file:86400,web_search:300"
 *   MCP_CACHE_ALWAYS_FRESH Tools that bypass cache: "bash,run_*"
 *   MCP_CACHE_MAX_TOKENS   Token limit for size threshold
 *   MCP_CACHE_CACHE_DIR    Cache directory path
 *   MCP_CACHE_DEBUG        Enable debug logging (true/false)
 *   MCP_CACHE_LOOP_THRESHOLD  Calls before circuit trips (default: 4)
 *   MCP_CACHE_LOOP_WINDOW_MS  Circuit window in ms (default: 60000)
 *
 * Examples:
 *   mcp-cache python -m my_mcp_server
 *   mcp-cache --fork-from sess_abc123 npx @modelcontextprotocol/server-filesystem /path
 *   MCP_CACHE_TOOL_TTLS=read_file:86400 mcp-cache node server.js
 */

import { MCPProxy } from './proxy.js';

async function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0) {
    console.error('Usage: mcp-cache [--session <id>] [--fork-from <id>] [--label <name>] <command> [args...]');
    console.error('Example: mcp-cache python -m my_mcp_server');
    process.exit(1);
  }

  // Parse mcp-cache options (consume flags before the command)
  let sessionId = process.env.MCP_CACHE_SESSION_ID;
  let forkFrom = process.env.MCP_CACHE_FORK_FROM;
  let sessionLabel = process.env.MCP_CACHE_SESSION_LABEL;
  let i = 0;

  while (i < argv.length) {
    if (argv[i] === '--session' && argv[i + 1]) {
      sessionId = argv[i + 1];
      argv.splice(i, 2);
    } else if (argv[i] === '--fork-from' && argv[i + 1]) {
      forkFrom = argv[i + 1];
      argv.splice(i, 2);
    } else if (argv[i] === '--label' && argv[i + 1]) {
      sessionLabel = argv[i + 1];
      argv.splice(i, 2);
    } else {
      i++;
    }
  }

  if (argv.length === 0) {
    console.error('Error: No command specified after options.');
    process.exit(1);
  }

  const command = argv[0];
  const commandArgs = argv.slice(1);

  try {
    const proxy = new MCPProxy(command, commandArgs, { sessionId, forkFrom, sessionLabel });
    await proxy.start();
  } catch (error) {
    console.error('mcp-cache: Failed to start:', error);
    process.exit(1);
  }
}

main();
