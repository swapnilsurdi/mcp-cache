# mcp-cache

> Universal response management wrapper for any MCP server

**Break free from token limits** - Automatic caching, pagination, and querying for large MCP responses.

[![npm version](https://img.shields.io/npm/v/mcp-cache.svg)](https://www.npmjs.com/package/mcp-cache)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## The Problem

MCP servers frequently return responses that exceed LLM context limits:
- 🌐 Full DOM content (1MB+ HTML)
- 📁 Large file system listings
- 🎨 Screenshot data
- 🔍 Extensive search results
- 🤖 UI accessibility trees

**Result:** `Error: Response exceeds maximum length of 1048576 bytes`

## The Solution

`mcp-cache` is a **transparent proxy** that wraps any MCP server and automatically:
- 🎯 Detects responses > 900KB
- 💾 Caches them with a unique ID
- 📊 Returns a manageable summary + query tools
- 🔍 Lets you search/paginate through cached data

**Zero modifications required** to your MCP servers!

## Quick Start

```bash
# Wrap any MCP server command
npx mcp-cache <your-mcp-server-command>

# Examples
npx mcp-cache python -m chrome_automation_mcp
npx mcp-cache npx @playwright/mcp@latest
npx mcp-cache node my-custom-server.js
```

## Features

✨ **Transparent** - Works with ANY MCP server
🎛️ **Client-Aware** - Auto-detects Claude/Cursor/etc token limits
💾 **Smart Caching** - 1-hour TTL with automatic cleanup (every 5min)
📄 **Pagination** - Automatic chunking for large responses
🔍 **Query Tools** - Text search, JSONPath, regex on cached data
⚙️ **Zero Config** - Works out of the box
🪶 **Lightweight** - <10ms overhead

## Installation

### Via npx (Recommended)
```bash
npx mcp-cache <command>
```

### Global Install
```bash
npm install -g mcp-cache
mcp-cache <command>
```

## Usage with Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "chrome-with-cache": {
      "command": "npx",
      "args": [
        "mcp-cache",
        "python",
        "-m",
        "chrome_automation_mcp"
      ]
    },
    "playwright-with-cache": {
      "command": "npx",
      "args": [
        "mcp-cache",
        "npx",
        "@playwright/mcp@latest"
      ]
    }
  }
}
```

**With custom settings:**

```json
{
  "mcpServers": {
    "chrome": {
      "command": "npx",
      "args": ["mcp-cache", "python", "-m", "chrome_automation_mcp"],
      "env": {
        "MCP_CACHE_MAX_TOKENS": "30000",
        "MCP_CACHE_TTL": "7200"
      }
    }
  }
}
```

## Real-World Example

### Before mcp-cache:
```
You: Get the full DOM of this page
Chrome MCP: [Returns 1.3MB of HTML]
Claude: ❌ Error: Response exceeds maximum length
```

### After mcp-cache:
```
You: Get the full DOM of this page
mcp-cache: Response too large (1.29MB, 133 chunks).
           Saved as resp_abc123.

           Use query_response('resp_abc123', '<query>') to search.
           Use get_chunk('resp_abc123', 0) to read chunks.

You: query_response('resp_abc123', 'button.submit', limit=5)
mcp-cache: [Returns 5 matching buttons]
✅ Success!
```

## Management Tools

When you wrap a server, `mcp-cache` adds 6 powerful tools:

### `query_response(response_id, query, limit?)`
Search cached responses with text, JSONPath, or regex:

```javascript
// Text search (case-insensitive)
query_response('resp_abc123', 'submit button', limit=10)

// JSONPath (complex queries)
query_response('resp_abc123', '$.div[?(@.class=="navbar")]')

// Regex (pattern matching)
query_response('resp_abc123', '/href=".*\\.pdf"/')
```

### `get_chunk(response_id, chunk_number)`
Retrieve specific chunks sequentially:

```javascript
get_chunk('resp_abc123', 0)   // First chunk
get_chunk('resp_abc123', 1)   // Second chunk
```

### `list_responses()`
View all cached responses:

```javascript
list_responses()
// Returns: [{id, tool, size, created, expires}, ...]
```

### `get_response_info(response_id)`
Get metadata about a cached response:

```javascript
get_response_info('resp_abc123')
// Returns: {id, tool, sizeBytes, chunks, expiresAt, ...}
```

### `refresh_response(response_id)`
Extend TTL by another hour:

```javascript
refresh_response('resp_abc123')
// Extends expiry time
```

### `delete_response(response_id)`
Manually delete a cached response:

```javascript
delete_response('resp_abc123')
```

## Configuration

### Environment Variables

```bash
# Token limits
MCP_CACHE_MAX_TOKENS=25000       # Override auto-detection
MCP_CACHE_CHUNK_SIZE=10000       # Chunk size in tokens

# Cache settings
MCP_CACHE_CACHE_DIR=~/.mcp-cache/cache  # Cache location
MCP_CACHE_TTL=3600                      # TTL in seconds (1 hour)

# Features
MCP_CACHE_ENABLE_INDEXING=true   # Enable full-text indexing
MCP_CACHE_COMPRESSION=true       # Compress cached responses

# Debug
MCP_CACHE_DEBUG=false            # Enable debug logging
```

### Client Presets

Automatic token limits based on detected client:

| Client | Default Token Limit |
|--------|-------------------|
| Claude Desktop | 25,000 |
| Claude Code | 25,000 |
| Cursor | 30,000 |
| Cline | 25,000 |
| Other | 20,000 |

Override with `MCP_CACHE_MAX_TOKENS` environment variable.

## How It Works

```
┌─────────────────┐
│  Claude Desktop │
│  (MCP Client)   │
└────────┬────────┘
         │ stdio
         ↓
┌──────────────────────────┐
│  mcp-cache (Proxy)       │
│  1. Spawns target server │
│  2. Forwards all messages│
│  3. Intercepts responses │
│  4. Caches if > 900KB    │
│  5. Adds query tools     │
└────────┬─────────────────┘
         │ stdio
         ↓
┌──────────────────┐
│  Target MCP      │
│  Server          │
│  (chrome, etc.)  │
└──────────────────┘
```

**Cache Storage:**
- Location: `~/.mcp-cache/cache/`
- Format: JSON files + metadata
- Cleanup: Every 5 minutes (automatic)
- TTL: 1 hour (default)

## Advanced Usage

### Debugging

Enable debug logging:

```bash
MCP_CACHE_DEBUG=true npx mcp-cache python -m chrome_automation_mcp
```

Check cache contents:

```bash
ls -lh ~/.mcp-cache/cache/
du -sh ~/.mcp-cache/cache/
```

### Custom Cache Location

```json
{
  "mcpServers": {
    "chrome": {
      "command": "npx",
      "args": ["mcp-cache", "python", "-m", "chrome_automation_mcp"],
      "env": {
        "MCP_CACHE_CACHE_DIR": "/tmp/my-cache"
      }
    }
  }
}
```

### Performance Tips

1. **Use specific queries** - Instead of searching the entire DOM, use CSS selectors
2. **Set lower limits** - `query_response(..., limit=10)` instead of default 100
3. **Use chunks for browsing** - Sequential `get_chunk()` calls for exploration
4. **Refresh responses** - Extend TTL if you need data longer than 1 hour

## Troubleshooting

### "Error: Response exceeds maximum length"

This means the response was SO large (>1MB) it couldn't even be cached. Solutions:
1. Use more specific tool calls (e.g., CSS selectors instead of full DOM)
2. Break operations into smaller parts
3. Use simpler tools that return less data

### Cache not clearing

Check automatic cleanup is running:
```bash
tail -f ~/.mcp-cache/debug.log
# Look for: "mcp-cache: Cleaned up X expired response(s)"
```

Manual cleanup:
```bash
rm -rf ~/.mcp-cache/cache/*
```

### "Client: unknown" in logs

This is cosmetic - the cache still works. The client detection happens during runtime and defaults to `claude-ai` if not detected.

## Compatibility

- ✅ **Node.js:** 18.0.0+
- ✅ **MCP Protocol:** 2024-11-05, 2025-06-18
- ✅ **Clients:** Claude Desktop, Claude Code, Cursor, Cline, custom clients
- ✅ **Servers:** ALL MCP servers (language-agnostic)

## Development

```bash
# Clone repository
git clone https://github.com/swapnilsurdi/mcp-cache.git
cd mcp-cache

# Install dependencies
npm install

# Build
npm run build

# Test locally
node dist/index.js python -m chrome_automation_mcp
```

## Contributing

Contributions welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## License

MIT - See [LICENSE](LICENSE) file

## Links

- [npm Package](https://www.npmjs.com/package/mcp-cache)
- [GitHub Repository](https://github.com/swapnilsurdi/mcp-cache)
- [Product Requirements](PRD.md)
- [Model Context Protocol](https://modelcontextprotocol.io)

## Similar Projects

- [chunky-mcp](https://github.com/ebwinters/chunky-mcp) - Requires modifying server code
- [MCP Inspector](https://github.com/modelcontextprotocol/inspector) - Debugging tool, not a production wrapper

**What makes mcp-cache different:**
- ✨ No server modifications needed
- ✨ Production-ready (not just debugging)
- ✨ Automatic cleanup
- ✨ Advanced query capabilities

## Acknowledgments

Built for the MCP community. Inspired by the need to work with real-world data that doesn't fit in token limits.

---

**Built for seamless MCP integration**