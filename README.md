# Shoulder

**Room for a side question.**

Select a passage in Codex and explore it in a fresh conversation beside the main one. Keep your train of thought, ask the tangent, and return when you're ready. Both chats run your installed native CLI.

![Select a passage from the main answer, press e, and edit an unsent question in a separate side chat.](https://raw.githubusercontent.com/jiselectric/shoulder/main/docs/assets/overview.png)

## Install

The npm package is **`shldr`**. Both `shoulder` and `shldr` run the same command.

Requires Node.js **22+**, tmux **3.6a+**, an authenticated native Codex CLI on `PATH`, and an interactive terminal outside an existing tmux session. Use at least **100 columns × 22 rows** for side chats.

For the npm alpha release:

```sh
npm install --global shldr@alpha
shoulder doctor
shoulder codex
```

To test an unpublished local candidate, install its reviewed tarball instead:

```sh
npm install --global /absolute/path/to/shldr-0.1.0-alpha.17.tgz
shoulder doctor
shoulder codex
```

`doctor` checks installed tool help and versions without making model requests. It does not verify authentication or a complete terminal workflow.

## Ask a side question

1. Run `shldr codex` from your project directory.
2. Ask your main question and wait for the answer to finish.
3. Press **Ctrl+Q** or click **Open side** for a blank side chat linked to the main conversation. Type your follow-up and submit it in Codex.

To ask about a particular passage:

1. Drag over a passage, then press **`e`**.
2. Shoulder opens a Codex conversation on the right with the passage in an **unsent draft** (or appends to the existing side draft).
3. Add your question after `My question:` and submit it in Codex.

Open side needs a completed saved main answer. If you open too early, Shoulder shows a brief message and keeps the main input usable.

Nothing is submitted automatically. Drag another passage and press `e` to append it at the side draft's cursor. Click or press Escape to leave selection mode and resume typing.

![Illustrative terminal showing the main conversation on the left and a quoted passage with an unsent question on the right.](https://raw.githubusercontent.com/jiselectric/shoulder/main/docs/assets/terminal-demo.png)

## Keep the native workflow

- **Follow the main conversation.** Before each reply, the side is instructed to use a local reader for completed main messages. It starts with recent context, then requests new messages with a checkpoint. If nothing changed, the reader returns a small confirmation instead of repeating the text. Older messages stay searchable; the full history is not copied at startup.
- **Your installed Codex.** Use native authentication, models, tools and permission settings. Optional side model and reasoning overrides stay explicit.
- **Drafts you control.** Selected text is placed in native input. Review it, edit it, and decide when to submit.
- **Close and come back.** Hide the side while preserving its conversation, draft, running answer and width for this Shoulder session.
- **A small local wrapper.** No runtime npm dependencies, model SDK, telemetry or direct model API client.

## Controls

| Action | Control |
| --- | --- |
| Open or append a side draft | Drag a passage, then `e` |
| Switch panes | Scroll over or click the pane, or **Ctrl+backslash** |
| Open / close / reopen side | **Ctrl+Q**, or click **Open side / Close side / Reopen side** |
| Start a fresh side chat | Click **Clear side**, or `Ctrl-b` then `c` |
| Hide / show the header | Click **Hide banner / Show banner**, or `Ctrl-b` then `b` |
| Resize the side | Drag the divider |

Scrolling focuses the pane under the pointer before passing its wheel event through. Native hover focus is enabled when supported by tmux; on tmux 3.6a, use scrolling or clicking. Mouse reporting must be enabled in the outer terminal. This changes only Shoulder’s private tmux server.

Direct shortcuts apply to Codex. Prefix fallbacks are `Ctrl-b` then `o` to switch panes and `Ctrl-b` then `x` to open/close/reopen. Release Ctrl before the action letter; no Shift is needed.

Start with compact bottom controls, or keep custom native key bindings:

```sh
shldr codex --no-banner
shldr codex --no-direct-keys
```

**Clear discards the side's draft and running turn.** Close preserves them until you reopen the side or exit Shoulder. Neither action deletes saved provider history. A side ended with native `/quit` cannot be reopened as the same live process.

Existing side processes retain the instructions they started with. After upgrading, recreate the side to receive the current reader policy. Clear does that while discarding its current draft/live chat; Close/Reopen keeps the old process.

The reader filters completed user messages and answers locally, omitting tool/configuration records. It returns bounded pages (12 KiB of serialized JSON by default); large updates can require multiple pages. A checkpoint records what was returned, not what the model remembers. After compaction or lost context, the side can request recent context again or retrieve older messages.

Context refresh still uses the native model's tools, so it adds side-response latency and input tokens. Delta reads reduce repeated response text; actual billed-token savings depend on tool choices, prompts, provider caching and conversation length and are not guaranteed. It is a model instruction, not a wrapper-enforced synchronization guarantee. If the native CLI cannot read the source, the side should explain that limit. The link follows the original source conversation UUID; after a native main `/new`, select a passage again to bind a side to the new conversation.

## Native options

Pass native flags through as usual. Put wrapper options before `--`; everything after it belongs to Codex:

```sh
shldr codex --side-model YOUR_MODEL --side-effort low
shldr codex -- --model YOUR_MODEL
shldr codex resume YOUR_EXACT_SESSION_UUID
```

Run `shoulder --help` for wrapper options. If a native option cannot be safely carried into a side conversation, the main still launches and the side action explains the limitation.

## Compatibility

macOS is validated with Node 22.22.2, tmux 3.6a and Codex 0.163.0. Linux wrapper, terminal and package tests pass in a Debian container with Node 22.23.3 and tmux 3.6a; authenticated native Codex acceptance is macOS-only. Use a UTF-8 locale (for example, `LANG=C.UTF-8` on Linux). Native Windows is unsupported. Terminal mouse reporting must reach tmux; in Apple Terminal, enable **View → Allow Mouse Reporting** if needed.

Claude and other executables support **main launch only** in this alpha. Automatic source-linked side drafts currently require Codex. Unknown native input screens, unfinished answers and uncertain conversation metadata block insertion instead of guessing. New provider versions and custom terminal bindings may need compatibility checks.

See [compatibility](https://github.com/jiselectric/shoulder/blob/main/docs/compatibility.md) and [verification evidence](https://github.com/jiselectric/shoulder/blob/main/docs/verification.md) for the tested scope. Context retrieval depends on the native model and tools; token savings, identical answers and zero overhead are not guaranteed.

## Privacy and security

Shoulder runs locally; your native CLI still handles provider requests, tools and saved history. Submitting a side question or reading source context can send selected text and earlier messages to that provider. Side permissions follow your native configuration; source-reading guidance is not a separate read-only sandbox.

Shoulder uses private temporary resources and cleans them on handled exits. Sudden process or machine failure can leave local resources. Close, Clear and exit do not erase provider history, and global terminal/tmux settings are not changed.

Read the [privacy disclosure](https://github.com/jiselectric/shoulder/blob/main/PRIVACY.md), [security boundaries](https://github.com/jiselectric/shoulder/blob/main/SECURITY.md) and [release checklist](https://github.com/jiselectric/shoulder/blob/main/docs/release.md). Licensed under [MIT](https://github.com/jiselectric/shoulder/blob/main/LICENSE). The package is prepared for the alpha release channel; publication is a separate maintainer action.

For vulnerabilities, use [private reporting](https://github.com/jiselectric/shoulder/security/advisories/new). Use [GitHub issues](https://github.com/jiselectric/shoulder/issues) for ordinary bugs and feature requests.
