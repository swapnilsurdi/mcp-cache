#!/usr/bin/env node
/**
 * mcp-cache - Universal response management wrapper for any MCP server
 *
 * Usage: mcp-cache <command> <args...>
 * Example: mcp-cache python -m chrome_automation_mcp
 */

import { MCPProxy } from './proxy.js';

async function main() {
  // Skip first two args (node and script path)
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: mcp-cache <command> <args...>');
    console.error('Example: mcp-cache python -m chrome_automation_mcp');
    process.exit(1);
  }

  const command = args[0];
  const commandArgs = args.slice(1);

  try {
    const proxy = new MCPProxy(command, commandArgs);
    await proxy.start();
  } catch (error) {
    console.error('Error starting mcp-cache:', error);
    process.exit(1);
  }
}

main();