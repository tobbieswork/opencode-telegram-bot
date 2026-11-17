# Throwaway E2E spec

*Temporary spec for the spec-to-tasks checkpoints (S4 "run a trivial task end to end", later S8). Safe to delete after they pass.*

## Design
No design — this spec exists to exercise the /spec Run flow with a trivial task.

## 1. Requirements
- E1.1 The task shall create a file `e2e.txt` at the repository root, containing exactly one line: `e2e ok` followed by a newline. No other changes.

## 2. Tasks
1. [ ] **E1 Create e2e.txt** (E1.1). Create the file as described in E1.1. *Checkpoint: `git show HEAD --stat` lists `e2e.txt` with one line.*

## 3. Out of scope
- Anything besides the single file `e2e.txt`.
