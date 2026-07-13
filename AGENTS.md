# Development Rules

- Keep provider wire formats inside `src/providers/`.
- Keep credentials behind `src/auth/`; never log, persist, or return secret values.
- Keep filesystem boundary checks centralized in `src/tools/paths.ts`.
- A requested sandbox must fail closed if isolation cannot be established.
- Tool failures are model-visible results; invariant failures stop the run.
- Session events are append-only. Derived context may be rebuilt at any time.
- Preserve opaque provider state byte-for-byte and do not expose hidden reasoning.
- Add or update tests for every behavior change.
- Run `npm run check` before considering a change complete.
- Keep the project-wide MIT notice in `LICENSE`; do not add per-file copyright
  headers, copied source, or copied prose.
