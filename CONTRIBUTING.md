# Contributing to Cursor Control Plane + CLI

Thank you for your interest in contributing! This document provides guidelines for contributing to the project.

## Development Setup

1. **Fork and clone**
   ```bash
   git clone https://github.com/your-username/cursor-cp-cli.git
   cd cursor-cp-cli
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure**
   ```bash
   cp config.default.yaml config.yaml
   # Edit config.yaml — set cursor.api_key at minimum
   ```

4. **Verify setup**
   ```bash
   npm run lint
   npm test
   npm run build
   ```

## Project Structure

```
src/
├── api/           # Fastify routes and WebSocket handlers
├── channels/      # Communication channel implementations
├── config/        # Configuration loading
├── core/          # Business logic (SessionManager, AgentService)
├── db/            # Database layer
├── models/        # TypeScript types and schemas
└── index.ts       # Entry point
```

## Coding Standards

### TypeScript

- Enable strict mode compliance
- Use explicit return types on exported functions
- Avoid `any` types when possible
- Use `unknown` for error handling, then type guard

### Testing

- Write tests for new features
- Tests should be alongside source files: `*.test.ts`
- Use descriptive test names
- Mock external dependencies (SDK, database)

### Commits

Use conventional commits:

```
feat: add new feature
fix: correct bug
docs: update documentation
refactor: code restructuring
test: add or update tests
chore: maintenance tasks
```

## Pull Request Process

1. **Before submitting:**
   - Run full test suite: `npm test`
   - Ensure type check passes: `npx tsc --noEmit`
   - Run linter: `npm run lint`
   - Build succeeds: `npm run build`

2. **PR Requirements:**
   - Clear description of changes
   - Link related issues
   - Add tests for new features
   - Update documentation if needed

3. **Review Process:**
   - All CI checks must pass
   - Code review by maintainers
   - Address review feedback

## Adding Features

### New API Endpoint

1. Add route handler in `src/api/routes.ts`
2. Add request schema in `src/models/schemas.ts` if needed
3. Add tests
4. Update README documentation

### New Channel

1. Create file in `src/channels/`
2. Implement `Channel` interface
3. Register in `src/index.ts`
4. Add tests

### Database Changes

1. Update schema in `src/db/connection.ts`
2. Create migration if needed
3. Update repository in `src/db/repositories.ts`
4. Add tests

## Testing Guidelines

### Unit Tests

```typescript
import { describe, it, expect, vi } from 'vitest';

describe('Feature', () => {
  it('should do something specific', async () => {
    // Arrange
    const input = 'test';

    // Act
    const result = await doSomething(input);

    // Assert
    expect(result).toBe('expected');
  });
});
```

### Mocking

```typescript
// Mock SDK
vi.mock('@cursor/sdk', () => ({
  Agent: {
    create: vi.fn(),
  },
  Cursor: {
    models: { list: vi.fn() },
  },
  CursorAgentError: class extends Error {},
}));

// Mock database
vi.mock('../db/connection.js', () => ({
  getDatabase: vi.fn(() => mockDb),
}));
```

## Release Process

1. Update version in `package.json`
2. Update `CHANGELOG.md`
3. Create git tag: `git tag v0.x.x`
4. Push tag: `git push origin v0.x.x`
5. CI will create release automatically

## Questions?

- Open an issue for questions
- Join discussions in GitHub Discussions
- Check existing issues before creating new ones

## Code of Conduct

- Be respectful and constructive
- Welcome newcomers
- Focus on what is best for the community
- Show empathy towards others

Thank you for contributing!
