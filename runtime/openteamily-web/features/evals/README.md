# features/evals (port of #493)

Agent evaluation suites: suites belong to one workspace agent, cases carry 1-8 weighted checks
(`equals`, `contains`, `not-contains`, `regex`, `min-length`, `max-length`), and `evaluate` scores a
caller-supplied candidate output per case. A case score is the weighted share of its checks that pass;
a run score is the weight-weighted mean of the case scores, so the total recomputes from the stored
`parts`. `compare` reports per-case deltas plus a ranking with a stable tie-break (delta, then case
name, then case id).

纯规则评分、不调模型: scoring is a pure function of the stored checks and the given output. No agent
turn, model, network or clock is involved while scoring, so two evaluations of the same inputs are
identical bit for bit. Every lookup is scoped by workspace; a suite, case or run from another
workspace answers exactly like an id that never existed. Data lives in `evals.sqlite3` on the user's
own volume.
