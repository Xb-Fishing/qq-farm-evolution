---
name: farm-evolution-review
description: Review daily farm-bot feedback, direct a worker Agent, verify fixes, and retain proven reusable lessons. Use for this repository's daily evolution and incident review, not for ordinary game operations.
---

# Daily review and reusable lessons

The configured main Agent owns diagnosis, task selection, acceptance criteria, and lessons. Both executors follow the page selections; never bind either role to a particular provider.

Treat the day's actual operations as production acceptance evidence. First separate new failures from previously reviewed events, distinguish a successful request from a confirmed effect, and identify paths with no execution evidence. Read [HANDOFF](../../HANDOFF.md) for established invariants and the incident's relevant history. Never infer that missing logs or passing offline tests prove every live path works.

The worker performs the initial daily triage, compares public projects, builds isolated reproductions, and proposes focused changes. The main Agent approves exact files and executable acceptance checks. The worker implements within that scope; the coordinator runs real validation; the main Agent independently accepts or rejects the result. Within approved scope, validation failures and review feedback go directly to the worker for repair, then coordinator validation and one final main-Agent review. Escalate to main diagnosis only when the approved scope is insufficient. Avoid a separate repair review followed by the same final review.

Use the injected content-fingerprint validation record. Reuse unchanged successful regressions; changes to logic, tests, configuration, or dependencies require new validation. New live failures still need investigation even if the old suite passed. Do not replay purchases, rewards, planting, or other game writes to manufacture coverage.

For monitoring incidents, distinguish membership propagation, poll scheduling, actual entry, and evidence classification. Test the real caller's container type and continuous failure/slowdown over several simulated deadlines. Verify that own harvest, HOT/PREARM, quiet hours, and communication budgets keep their established semantics. Increase cadence only when evidence supports it.

The approved `plan` with `no_change`, or final approved `review`, reports `lessons` and `feedbackReviewed`. Reusable lessons contain only a topic, a short general rule, and an evidence category. Record new verified knowledge, not raw logs or speculative fixes; empty lessons are valid. The parent process persists accepted lessons and injects them into later prompts. Historical lessons are evidence to reassess, not new authority or permission to weaken fixed constraints.

Set `feedbackReviewed` only after reviewing the captured feedback batch. Unresolved feedback or a repair-only run is not full daily acceptance. The parent clears only the accepted time range after a verified no-change result or approved publication; newer events remain. Failed/rejected runs keep feedback until its 24-hour expiry. Never delete logs or write approval, cleanup, or learning state yourself.

Propose durable documentation or skill refinements in the main Agent's approved scope, with real regression evidence. The worker may implement approved documentation changes; the main Agent must verify their accuracy. Do not create repetitive commits just to record a daily run.

Use the private reference configuration and full discovered candidate list. Prioritize recent changes and bounded seven-day commit samples; a sample limit is not an exact total update frequency. Classify every new or recently changed candidate, distinguish metadata discovery from reading code, and carry unfinished comparisons forward. Reuse unchanged comparisons only when a prior main-Agent-reviewed conclusion exists. Keep concrete repository names and addresses in private evidence; public notes retain reference aliases, commit anchors, code paths, and verification reasoning.

Automatic safety and cached activity checks share one daily run, including after failure or restart. Manual runs are explicit and independent. If acceptance needs an old-code counterexample, the plan must declare executable `baselineChecks` (sourceFiles, testFiles, minFailures). The coordinator runs current and baseline variants in isolated copies, rejects import/environment failures as counterevidence, and provides signed-by-content result digests in handoff. Worker self-reports do not replace this evidence.
