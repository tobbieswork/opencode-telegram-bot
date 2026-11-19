# T5 Rerun test

*Temporary spec written to live-test the T5 (ocr-hardening) re-run guard. Delete after the test.*

## 1. Requirements

- R1.1 The task shall create a file `t5-rerun-ok.txt` at the repository root, containing exactly one line: `t5 rerun ok` followed by a newline. No other changes.

## 2. Tasks

1. [ ] **R1 Create t5-rerun-ok.txt** (R1.1). Create the file as described in R1.1. *Checkpoint: `cat t5-rerun-ok.txt` prints `t5 rerun ok`.*

## 3. Out of scope

- Anything besides the single file `t5-rerun-ok.txt`.
