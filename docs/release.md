# Shoulder release checklist

**Publication hold:** alpha.13 failed subsequent natural context-follow-up acceptance and must not be published. Its earlier explicit-read test proved source access, not fresh retrieval on ordinary later questions. Alpha.14 passed three native cases with two main updates and unhinted same-side questions, 175-test macOS/Linux gates, and 200-cycle lifecycle/header stress. An earlier isolated header fork-count timeout remains unexplained despite 300 subsequent passing cycles; it is recorded in the verification report and must not be described as fixed. Review that limitation before approving a release. Both source upload and npm publication remain held for owner approval.

The prepared candidate is **`shldr@0.1.0-alpha.17`**, with identical `shoulder` and `shldr` commands. License: [MIT](../LICENSE). Repository: [jiselectric/shoulder](https://github.com/jiselectric/shoulder). Private vulnerability reporting is enabled. No npm publication has been performed by this preparation task.

**Alpha.15 is superseded:** clicking Open side before saved context could open a raw helper-output view over main. Alpha.16 preserves the context guard but completes handled UI rejections cleanly; its macOS and clean Linux 196-test gates, real native rejection/recovery check, 100 rejection stress cycles and 50 header stress cycles passed. See the verification record for the failed harness iteration and remaining limitations. Do not use alpha.15’s earlier green tests as acceptance of that missing negative case.

Historical alpha.15 adds selection-free opening through Ctrl+Q, prefix x, or Open side. Its final macOS and Linux 186-test gates, installed-package smoke, benchmark, 32-file dry-runs, 100-cycle lifecycle and 50-cycle header stress, and two fresh native context follow-ups passed. Focus-on-scroll addresses the owner’s recorded focus mismatch and passes a real Codex long-history check. Independent exact-frame instrumentation traced captured lifecycle refusals to partial synthetic redraws; only the fixture frame writer changed, preserving all production guards and malformed-frame cases. The earlier uninstrumented observations remain in the review. A second stress attempt overlapped a rebuild and is invalid for acceptance. Alpha.14 evidence below remains historical. This is a prepared test candidate, not unconditional release sign-off.

**Alpha.17 context optimization:** the side uses a local completed-message reader with explicit checkpoints, unchanged receipts and paged older search. Alpha.16 remains historical; its checks do not accept the new code. Review alpha.17's own parser/CLI, native-context, regression/package and independent safety evidence in the verification record. Filtering reduces repeated tool response text; model recall, synchronization and billed-token savings remain unguaranteed.

## Publication status

The owner selected `shldr`: the unrelated unscoped `shoulder` package is already registered. The latest registry check for `shldr` returned E404; this does not reserve the name or prove the publishing account can claim it. The earlier preparation check of `npm whoami` returned ENEEDAUTH; authentication must be checked again before an approved release.

The temporary `private: true` and UNLICENSED metadata have been removed after the owner's MIT/name/repository decisions. Package smoke now requires MIT, the complete license, reviewed public files, no private guard, and `publishConfig` selecting public access and the alpha tag. These settings permit publication of the reviewed archive after final checks and owner approval, without editing its bytes afterward. Removing the guard does not publish the package.

Both public source upload and npm publication are held for the owner's explicit approval. The new GitHub repository exists, but its release source and images remain local until that approval. README image and document URLs will resolve only after the approved source upload; verify those links before publishing to npm.

Before publication, the maintainer must authenticate with npm, confirm the intended account and its required account-security settings, and authorize the actual release. Do not share tokens in chat, source, or public issues. Review the final artifact digest and the [verification record](verification.md); publish that exact reviewed tarball. Do not promote this alpha to stable solely because tests pass.

```sh
npm login
npm whoami
npm publish ./shldr-0.1.0-alpha.17.tgz --access public --tag alpha
```

These are maintainer instructions, not evidence that publication has run. If ownership or name checks fail, resolve them before retrying or choosing a new scope. Any source, dependency, license or shipped-document change requires repacking and checking the new artifact.

## Reproduce candidate checks from source

Use a currently patched supported Node LTS release, minimum Node 22, tmux 3.6a+, and a UTF-8 terminal locale. On Linux, `LANG=C.UTF-8` is a suitable available locale in the tested Debian environment.

```sh
npm ci
npm run release:check
npm run verify:stress -- --cycles 200
npm run verify:stress:header -- 50
npm run verify:context
npm pack
npm install --global /absolute/path/to/shldr-0.1.0-alpha.17.tgz
shoulder --version
shldr --help
shoulder doctor
```

Run the stress harnesses separately; do not rebuild shared `dist` during an active terminal test. They use real private tmux terminals and deterministic native stand-ins without model requests. Lifecycle stress covers unsent drafts, selection, append, same-pane Clear, hide/reopen, narrow-terminal refusal, resize recovery and process cleanup. Header stress additionally covers public CLI startup, direct shortcuts, clickable banner controls, exact selected-text drafts and responsive geometry. It deliberately separates independent mouse gestures beyond tmux's 300 ms multi-click grouping interval and waits for complete native frames after resize. Separate regression tests cover fast click cancellation and returning to native typing.

`verify:context` makes six authenticated Codex turns, consumes provider quota and retains normal provider histories. It opens the side before two later main updates, asks ordinary follow-ups without retrieval hints plus an unchanged-context question, and requires a new exact-source tool read and the correct fresh answer on each side turn. It requires the local reader, consumption of the preceding checkpoint, an unchanged receipt with no message text, and a later delta without repeated earlier text. It also checks no canary replay in side input, unchanged parent bytes per side operation, the same side UUID, and Clear retaining pane/width with a fresh identity. Ordinary tests, doctor, smoke and the deterministic benchmark make no model requests.

`release:check` typechecks, runs unit and private-terminal regressions, installs the actual archive under a path with spaces, checks both aliases/help/version/controlled doctor, benchmarks bounded local setup and inspects the pack inventory. The exact **36-file** public inventory includes compiled code/declarations (including the local context engine and CLI), metadata, README, MIT license, security/privacy disclosures, three public documents and four static PNG/SVG illustrations. It excludes tests, source-only reports, histories, credentials, runtime resources and temporary QA logs. Clean builds remove stale output before packing.

## Accepted scope and limits

macOS has synthetic terminal and authenticated Codex acceptance. Linux has clean-install, synthetic terminal, package and stress acceptance in the documented container; this does not establish Linux native-provider authentication/layout parity. Native Windows is unsupported. Claude/generic executables support main launch only; automatic source-linked drafts require Codex.

The side uses native tools and permissions. Submitted questions and source reads can send prior messages to the native provider. Close keeps a live side; Clear/exit do not erase provider histories. Review [privacy](../PRIVACY.md), [security](../SECURITY.md), and [compatibility](compatibility.md). Passing the checks is evidence for the tested conditions, not a universal security or performance guarantee.
