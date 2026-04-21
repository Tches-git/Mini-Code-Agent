# Terminal UI architecture notes

## Purpose

This project now treats terminal rendering as a first-class architectural layer rather than scattered `console.log` usage.

## Boundaries

- `src/cli/*`: page composition and command-specific presentation
- `src/utils/logger.ts`: public logger facade used by CLI code
- `src/utils/logger/core.ts`: text cleanup, width, wrapping, truncation, inline formatting
- `src/utils/logger/rich-text.ts`: markdown-ish block rendering and table rendering
- `src/utils/logger/spinner.ts`: interactive spinner state
- `src/agent/orchestrator.ts`: orchestration entry point only
- `src/agent/orchestrator-*.ts`: focused implementation modules for state, validation, tool execution, config, and task intent
- `src/types/agent.ts`: shared agent-facing runtime contracts
- `src/types/llm.ts`: shared LLM response and stream contracts
- `src/types/cli.ts`: shared CLI render-oriented contracts

## Rules for future changes

1. Keep `src/utils/logger.ts` as a facade; new logger internals should go under `src/utils/logger/`.
2. Keep `AgentOrchestrator` as the entry point; new orchestration logic should prefer focused sibling modules.
3. UI wording changes should update:
   - README user-facing examples or capability descriptions when relevant
   - logger snapshot tests if layout changes
   - CLI tests when command output structure changes
4. Do not keep backup source files like `*.bak` in `src/`.

## Validation expectation

For terminal UI or CLI structure changes, run at least:

```bash
npm test
npm run build
```
