---
name: review-code
description: Review code changes for quality, correctness, and potential issues
license: MIT
compatibility: opencode
metadata:
  audience: developers
  workflow: code-review
---

## What I do

Review code changes from git diff, staged changes, and recent commits. Analyze for quality, correctness, and potential issues across any language or framework.

## Workflow

1. Run `git status` to identify the current branch and changed files
2. Run `git diff` and `git diff --cached` to see unstaged and staged changes
3. Run `git log --oneline -5` for recent commit context
4. Read relevant files for full context when needed
5. Provide structured feedback

## Analysis Checklist

### Logic & Correctness
- Off-by-one errors, incorrect comparisons, misplaced conditions
- Missing or incorrect guard clauses
- Race conditions, async/await misuse
- Memory leaks, resource leaks (unclosed connections, timers, listeners)

### Type Safety
- Missing types, overuse of `any`/`unknown`
- Incorrect type assertions, unsafe casts
- Missing return type annotations on complex functions

### Error Handling
- Uncaught exceptions, missing try/catch
- Swallowed errors, empty catch blocks
- Missing validation for external inputs
- Inadequate error messages for debugging

### Performance
- Unnecessary re-renders (React), missing memoization
- Unoptimized loops, N+1 queries
- Large payloads, missing pagination
- Blocking operations on main thread

### Security
- Hardcoded secrets, API keys, credentials
- SQL injection, XSS, CSRF risks
- Unsafe `eval()`, raw HTML rendering
- Missing authentication/authorization checks
- Overly permissive file access

### Code Quality & Conventions
- Duplicate code that should be extracted
- Functions doing too many things, names that don't match intent
- Deeply nested logic that should be flattened
- Missing comments for complex/non-obvious logic
- Inconsistent formatting, naming, and style

### Testing & Coverage
- Uncovered error paths and edge cases
- Tests missing assertions or proper setup/teardown
- Mocking real dependencies that shouldn't be

## Output Format

```
## Code Review: [branch]
### Summary
[Brief overview of changes and overall impression]

### Findings
#### Critical
- [file:line] - [issue description]

#### Warnings
- [file:line] - [issue description]

#### Suggestions
- [file:line] - [improvement suggestion]
```

## Severity Definitions

| Level       | Meaning                                                        |
|-------------|---------------------------------------------------------------|
| **Critical** | Will cause a bug, crash, or security vulnerability            |
| **Warning**  | Likely issue, anti-pattern, or risk that should be addressed  |
| **Suggestion** | Improvement for readability, maintainability, or best practice |

## When to use me

Use this skill when asking to review code changes. Ask clarifying questions if a specific area of concern should be prioritized (e.g., "focus on security" or "focus on performance").
