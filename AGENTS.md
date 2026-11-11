# AGENTS.md — Scrap Download Viewer

Agent guidance lives in **`.cursor/rules/`** (split by concern):

| Rule | Scope |
|------|--------|
| `todo-selection.mdc` | Selected Project TODO canvas Work items (sidecar + TODO.md fallback) |
| `project-overview.mdc` | Always — stack, run, verify |
| `product-rules.mdc` | Always — product behavior |
| `testing.mdc` | Always — auto-tests, when to run/propose/extend |
| `git-workflow.mdc` | Always — Git safety, when/how to commit, never-commit paths |
| `frontend.mdc` | `frontend/**` |
| `backend.mdc` | `backend/**` |

Prefer **current code** over `README.md` when they disagree. After behavior changes, update the matching rule file(s) and `README.md`.
