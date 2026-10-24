# @lypcut/timeline-core

The timeline engine, shared by the editor (`frontend/`) and the server (`backend/`): the timeline types, the ops and
their validation and inverses, read-only queries, the transcript-to-ops builders (remove fillers, trim pauses, keep a
range, captions) and the builder for a project's first timeline. Pure functions, no I/O.

Because both sides run this one copy, an edit made in the browser and the same edit made on the server give identical
timelines, including the ids of the clips it creates (`sequentialIds('i_v<version>_')`), and an op the planner proposes
is checked by exactly the rules the editor enforces.

- **Tests** live with the consumers: `frontend/src/lib/timeline/*.test.ts` and `backend/test/unit/timeline-*.test.ts`.
- **Used from source** in development and tests (Vite alias in the front end, `paths` and a Vitest alias in the backend).
  The backend's production build compiles it first (`npm run build:pkg`), and the Docker image installs the result as
  `node_modules/@lypcut/timeline-core`. The Docker build context is therefore the repository root.
