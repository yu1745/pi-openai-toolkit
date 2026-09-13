# pi-subagents context-management identity patch

## Base and status

- Target: `/home/wangyu/.pi/agent/git/github.com/yu1745/pi-subagents`
- Required base commit: `a957ffe4a1cb79fc0371ec5638f100663fcecdbb` (`master`)
- Patch: `pi-subagents-context-identity.patch`
- Status: applied to the local target checkout after explicit user approval. Source and focused tests are now working-tree changes; CI, index, commits and branches were not changed. The patch remains a delivery/reference artifact, not an automatic CI regeneration step.
- The target has no automatic patch-application entrypoint. Its removed `.github/workflows/sync-and-patch.yml` remains absent and is not restored by this delivery.

## Change

The patch adds `src/context-management-identity.ts` and calls it after the child `SessionManager` is created but before `createAgentSession`.

It writes an append-only `context-management-agent-identity` custom entry:

```ts
{
  version: 1,
  sessionId: childActualId,
  rootSessionId: rootActualPiSessionId,
  agentName: "/root/<stable-agent-id>"
}
```

For nested children, a valid parent entry whose `sessionId` exactly matches the parent manager's current session ID supplies the root ID and namespace. A resumed child with valid metadata for its current ID is not written again. Copied fork metadata whose ID does not match the current session is ignored. Missing or partial SessionManager APIs are treated as best-effort metadata failures, not startup failures.

## Applying after review

The fork's current `FORK.md` calls for direct source maintenance with tests, not ongoing CI patch regeneration. The patch is a reviewable delivery artifact, not a proposal to restore the old maintenance model. After explicit approval, apply it to the stated base and commit the resulting source changes normally. No application, commit or push is performed by this toolkit.

If a separate downstream CI still needs a patch-application step, the following is an optional example, **not a change to the current fork CI**. Do not restore the deleted reset/force-push workflow:

```yaml
- name: Apply context identity patch
  run: |
    git apply --check /path/to/pi-openai-toolkit/patches/pi-subagents-context-identity.patch
    git apply /path/to/pi-openai-toolkit/patches/pi-subagents-context-identity.patch

- name: Verify context identity patch
  run: |
    bunx vitest run test/context-management-identity.test.ts
    bun run typecheck
```

The CI job should pin or verify the base commit before applying, because the patch is intentionally line-based.

## Verification performed in `/tmp/pi-subagents-context-identity`

```text
bun --version                         # 1.3.14
bunx biome check src/context-management-identity.ts src/agent-runner.ts test/context-management-identity.test.ts
# Checked 3 files; no fixes applied
bunx vitest run test/context-management-identity.test.ts
# 1 file passed, 7 tests passed
bun run typecheck
# tsc --noEmit passed
git diff --check
# passed
git -C /home/wangyu/.pi/agent/git/github.com/yu1745/pi-subagents apply --check <patch>
# passed
```

Vitest emitted its existing Vite `configLoader: 'native'` future-compatibility warning; the focused test still passed.

## Coverage and boundaries

The focused helper tests cover root children, nested namespace inheritance, resume deduplication, fork-copied metadata isolation, absent parent context, incomplete memory-like managers, and invalid namespace/root data.

Not covered: a real Pi SDK child launch with on-disk sessions, downstream pi-openai-toolkit history/notes projection of the custom entry, and full-suite execution. The patch deliberately does not infer identity from `header.parentSession`, aliases, display names, scheduling, or model interfaces.
