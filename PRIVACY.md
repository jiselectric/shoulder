# Shoulder privacy

Shoulder is a local terminal wrapper. Its source contains no analytics, telemetry, advertising, tracking identifier, model SDK, or direct network client. It starts your installed native CLI and a private tmux server. Your native CLI can contact its provider, run tools and retain histories according to its own configuration and policies. This statement describes Shoulder, not the privacy practices of an AI provider or npm.

## What data goes where

| Data | Shoulder handling | Native provider handling |
| --- | --- | --- |
| Main terminal output | Rendered directly by the native process in tmux; current visible screen captured when a side action needs its exact session ID | Governed by the native CLI |
| Session filenames and metadata | Enumerates local session directories; opens the exact UUID candidate to check identity, model, effort, cwd and lifecycle | Created and retained by the native CLI |
| Selected passage | Sanitized, limited to 16 KiB UTF-8, briefly staged through an owner-only local file/private tmux buffer, then placed into an unsent native draft | Can be retained in native UI/history; submission sends it through the native provider's normal path |
| Source reference | Exact UUID and absolute transcript path supplied as side developer instructions | Those instructions and any tool-read source messages can become side model input and saved history |
| Launch options and paths | Saved in owner-only local runtime state while the wrapper is running | Passed as native argv as required; provider may save its settings |
| Authentication | Shoulder does not read or manage provider credentials | The native executable uses its existing authentication/environment |

Metadata scans parse JSONL records transiently to validate lifecycle. They do not collect transcript content into a new searchable database or transmit it themselves. Before each side reply, the native model is instructed to run a read-only local context reader against the exact source transcript. The reader filters completed user messages and answers, omits tool/configuration payloads, and returns bounded JSON pages. It starts with recent context, then accepts source-bound checkpoints for new messages or a small unchanged response. Older textual messages remain accessible through literal search and exact-message paging. No summary model or persistent transcript copy is created.

The checkpoint is returned as tool output and kept in the side conversation's native history, rather than a shared mutable consumption file. It contains positions and source-bound fingerprints, not conversation text. Search/older-message reads do not advance that refresh checkpoint. Rewrites reset to recent context; compaction or forgotten checkpoints can cause a fresh snapshot and repeated reads. A local scan can fail safely if the source changes during the read.

These native tool reads can expose main conversation text to the side provider, even for a side question that does not obviously need it. Returned text and checkpoints can be retained in native history. Reader bounds apply to its own output/scan only; they do not constrain arbitrary native tools. Invocation and correct use of checkpoints remain model guidance, not enforced synchronization, recall, a read-only sandbox or a guarantee of billed-token savings. Native permissions still govern access.

Selected content is data, not shell command source. Selection and staging do not press Enter. A quote can still contain misleading instructions for a model, so review the draft before submitting it. Shoulder does not establish a separate permissions sandbox for the side; native options, environment and applicable project instructions remain in effect.

Native arguments may themselves contain sensitive settings or an initial prompt. Shoulder preserves them rather than redacting or rewriting them: they can appear in owner-only runtime state and in the native process's argv, subject to the OS's process inspection rules. Native diagnostics may include paths or other user-supplied values; review them before sharing.

## Retention and cleanup

The startup header is rendered locally by tmux and does not read or write preferences. It is separate from the native pane: header text is not inserted into provider input, and typing goes directly to the native CLI. Shoulder adds no startup input capture or acknowledgement screen. Older alpha.8 installations may have left a two-byte `welcome-v1` marker under `$XDG_STATE_HOME/shldr/` or `~/.local/state/shldr/`; current versions ignore it, and it can be removed.

Runtime directories use unpredictable `/tmp/shoulder-*` names with mode 0700; state, requests and quote transfer files use mode 0600. Quotes are removed from transfer files/buffers after staging. Cleanup attempts to terminate native main/side processes and their private server when the wrapper exits, and removes owned runtime files on handled exit paths. Close preserves the live side—including any unsent draft and in-flight answer—in a hidden window until Reopen or wrapper exit. Clear resets its live conversation and draft.

**Close, Clear, and wrapper exit do not delete provider history.** Manage saved conversations through your native provider. Sudden machine failure, SIGKILL, or a killed helper can leave local runtime resources. These files are not a secure-erasure mechanism, and disk backups/snapshots may retain deleted bytes. The same OS account, administrators and malware running as you are outside the private-file boundary.

No global tmux/terminal/provider settings are written by Shoulder. Invocation-local side developer instructions replace a configured `developer_instructions` value for that side; the main is unchanged. The native provider can independently persist its own settings or histories.

## Diagnostics and verification

Normal help, version, doctor, tests, package smoke and the controlled startup benchmark do not make model requests. Doctor executes help/version checks for installed tools. `npm run verify:context` explicitly creates six authenticated Codex turns and keeps their normal native histories. It opens a side before two main updates, then asks ordinary follow-ups and requires fresh local-reader evidence for each new answer, a delta using the previous checkpoint, and an unchanged refresh with no repeated text. Its output identifies the disposable session UUIDs and reports evidence checks; avoid posting private paths, full transcripts, credentials, or complete environment dumps in bug reports.

The distributable includes compiled application files and public documentation. Review reports, test fixtures, local provider transcripts, credentials and temporary acceptance logs are excluded and checked by the package smoke test. See [security](SECURITY.md), [compatibility](docs/compatibility.md), and [release requirements](docs/release.md).
