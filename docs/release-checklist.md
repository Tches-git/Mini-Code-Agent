# Release Checklist

This checklist defines the local and CI quality gates for publishing `local-code-agent`.

## Development gate

Run before merging regular code changes:

```bash
npm test
npm run build
```

## Release candidate gate

Run before cutting an npm or standalone release candidate:

```bash
npm run check
npm run pack:verify
npm run benchmark:smoke
```

Expected outcome:

- lint, tests, and TypeScript build pass;
- package contents include `dist/cli/index.js`;
- package contents do not include compiled test artifacts;
- smoke benchmark completes without unexpected infrastructure failures.

## Standalone release gate

Run before publishing standalone artifacts:

```bash
npm run build:standalone:gha
```

Expected outcome:

- standalone binary is built from the current `dist` output;
- `scripts/verify-standalone.mjs` passes;
- CLI startup and basic command wiring are verified.

## CI summary expectations

Release/benchmark CI jobs should summarize:

- command(s) executed;
- pass/fail status;
- benchmark task counts by category;
- skipped benchmark tasks and reasons;
- package or standalone artifact verification result.

## Benchmark success threshold

For smoke benchmarks:

- all enabled smoke tasks should pass, or skipped tasks must include an explicit precondition reason;
- environment failures indicate runner or dependency issues and should block release until understood;
- product regressions in read/edit/validate/auto-fix tasks should block release.
