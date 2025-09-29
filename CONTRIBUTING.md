# Contributing to mcp-cache

Thank you for your interest in contributing to mcp-cache! This document provides guidelines and information for contributors.

## Code of Conduct

Be respectful, inclusive, and considerate of others. We're all here to build something useful for the MCP community.

## How to Contribute

### Reporting Issues

If you find a bug or have a feature request:

1. Check if the issue already exists in [GitHub Issues](https://github.com/swapnilsurdi/mcp-cache/issues)
2. If not, create a new issue with:
   - Clear title and description
   - Steps to reproduce (for bugs)
   - Expected vs actual behavior
   - Your environment (OS, Node version, MCP client)
   - Relevant logs from `~/.mcp-cache/` or Claude logs

### Suggesting Features

Feature requests are welcome! Please:

1. Explain the use case
2. Describe the proposed solution
3. Consider alternatives
4. Be open to discussion

### Pull Requests

We love pull requests! Here's the process:

1. **Fork the repository**
   ```bash
   git clone https://github.com/YOUR_USERNAME/mcp-cache.git
   cd mcp-cache
   ```

2. **Create a branch**
   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/your-bug-fix
   ```

3. **Make your changes**
   - Write clean, readable code
   - Follow existing code style
   - Add comments for complex logic
   - Update documentation if needed

4. **Test your changes**
   ```bash
   npm run build
   node dist/index.js python -m your_test_mcp_server
   ```

5. **Commit your changes**
   ```bash
   git add .
   git commit -m "feat: add awesome feature"
   # or
   git commit -m "fix: resolve caching issue"
   ```

   Use conventional commits:
   - `feat:` - New feature
   - `fix:` - Bug fix
   - `docs:` - Documentation changes
   - `refactor:` - Code refactoring
   - `test:` - Adding tests
   - `chore:` - Maintenance tasks

6. **Push and create PR**
   ```bash
   git push origin feature/your-feature-name
   ```
   Then create a pull request on GitHub.

## Development Setup

### Prerequisites

- Node.js 18.0.0 or higher
- npm or yarn
- An MCP server to test with

### Setup

```bash
# Install dependencies
npm install

# Build project
npm run build

# Watch mode for development
npm run dev
```

### Project Structure

```
mcp-cache/
├── src/
│   ├── index.ts        # CLI entry point
│   ├── proxy.ts        # Core proxy logic
│   ├── transport.ts    # Server communication
│   ├── cache.ts        # Cache management
│   ├── query.ts        # Query engine
│   ├── config.ts       # Configuration
│   └── types.ts        # TypeScript types
├── dist/               # Compiled JavaScript
├── tests/              # Tests (coming soon)
└── docs/               # Documentation
```

### Testing

Currently, testing is manual. To test your changes:

1. **Build the project**
   ```bash
   npm run build
   ```

2. **Test with a real MCP server**
   ```bash
   node dist/index.js python -m chrome_automation_mcp
   # or
   node dist/index.js npx @playwright/mcp@latest
   ```

3. **Test with Claude Desktop**
   - Update `claude_desktop_config.json` to point to your local build
   - Restart Claude Desktop
   - Try operations that trigger large responses

4. **Check logs**
   ```bash
   tail -f /Users/YOUR_USERNAME/Library/Logs/Claude/mcp-server-*.log
   ```

### Code Style

- Use TypeScript strict mode
- Prefer `async/await` over promises
- Use descriptive variable names
- Keep functions small and focused
- Add JSDoc comments for public APIs

Example:

```typescript
/**
 * Query a cached response with various search methods
 * @param data - The cached response data
 * @param query - Search query string
 * @param options - Query options (mode, limit, offset)
 * @returns Query results with pagination info
 */
query(data: any, query: string, options: QueryOptions = {}): any {
  // Implementation
}
```

## Areas for Contribution

### High Priority

- [ ] Add automated tests (unit + integration)
- [ ] Implement response compression (gzip)
- [ ] Add full-text search indexing (SQLite FTS5)
- [ ] Better error handling and logging
- [ ] Performance optimizations

### Medium Priority

- [ ] Semantic search with embeddings
- [ ] Response merging capabilities
- [ ] Export/import functionality
- [ ] Web dashboard for cache management
- [ ] Statistics and monitoring

### Documentation

- [ ] More usage examples
- [ ] Video tutorials
- [ ] Integration guides for popular MCP servers
- [ ] Troubleshooting guide expansion
- [ ] API documentation

### Nice to Have

- [ ] Support for remote MCP servers (HTTP transport)
- [ ] Cache sharing between clients
- [ ] Response versioning
- [ ] Query result caching
- [ ] Custom query plugins

## Questions?

Feel free to:
- Open an issue for questions
- Join discussions in GitHub Discussions (coming soon)
- Reach out to maintainers

## Attribution

All contributors will be recognized in the project README and release notes.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

---

Thank you for helping make mcp-cache better! 🚀