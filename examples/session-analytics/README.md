# Session analytics example

`session_usage_summary` reads the host's durable usage aggregate for one explicit session branch. It reports historical token counts, cache reads and writes, decimal cost text, duration, and cache-health classification without replaying or scanning the transcript.

From this directory:

```sh
node --test activation.test.mjs
rigyn install .
rigyn --tools session_usage_summary -p "Show the current session usage summary and explain only the measured fields."
rigyn remove session-analytics-example
```

Usage can be unavailable when a provider did not emit it. Treat absent fields as unknown rather than zero, and keep cost as the host-provided decimal string instead of converting it through floating-point arithmetic.
