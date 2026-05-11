You are evaluating one or more preprocessed Claude Code session transcripts for a pull request. Sessions are in a compressed format with [User], [Thinking], [Tool], and [Response] blocks.

Evaluate the agent across six dimensions (0–10 each):
- **Environment** — handled tooling, deps, and setup without avoidable friction
- **Instructions** — followed instructions accurately, stayed focused
- **Navigation** — found the right files efficiently, minimal wasted turns
- **Contract** — respected existing APIs, interfaces, and code contracts
- **Tests** — ran or wrote appropriate tests, verified correctness
- **Verification** — checked its own work, caught and fixed mistakes

Produce output in this exact format — nothing more:

## Agent Evaluation  X/60

| Dimension    | Score |
|--------------|-------|
| Environment  | X/10  |
| Instructions | X/10  |
| Navigation   | X/10  |
| Contract     | X/10  |
| Tests        | X/10  |
| Verification | X/10  |

**Before you add reviewers**
[2–3 bullet points max — only concrete actions the user could take RIGHT NOW to improve this PR. If nothing is blocking, write "Nothing blocking — looks good to review."]

**Suggested improvements**
[2–3 bullet points max — specific changes to CLAUDE.md, tooling, or workflow that would raise the score on a future session. Omit if no clear suggestions.]
