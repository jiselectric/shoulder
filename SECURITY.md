# Shoulder security

Shoulder is an early release candidate. The release review uses adversarial local fixtures, independent code review, real tmux/PTY tests, package inspection and dependency auditing. Passing these checks is evidence about tested conditions, not a guarantee against all vulnerabilities.

## Trust boundaries

Shoulder trusts the OS user account, Node runtime, installed `tmux` and native model executable on PATH, and the provider's own saved session files/configuration. Run it without elevated OS privileges. A compromised executable or another process running as the same user can act with your account's access; private files do not isolate those adversaries.

Use a currently patched supported Node LTS release (minimum Node 22; Node 24 LTS is also a supported-line choice requiring your platform acceptance). Node 20 is end-of-life according to the [upstream release status](https://nodejs.org/en/about/previous-releases), so it is no longer the declared release minimum even though historical local development tests ran on it. Package advisory auditing does not audit the security of your Node, tmux or native provider installation.

Selections, filesystem project names and native terminal output are untrusted input. Selection bytes must never become shell/tmux command source or automatic submissions. Exact provider UUID, transcript candidate uniqueness, completed lifecycle and idle native composer checks protect source binding and draft insertion. Missing or unrecognized identity/lifecycle evidence required by the adapter, malformed JSON and partial records are rejected; unrelated source record types are ignored. The final check reduces but cannot eliminate races with a separate native process changing immediately afterward; this is terminal automation, not a provider transaction API.

The side has the native CLI's effective permissions. It is not forcibly read-only and may have workspace/tool access inherited from your explicit flags and profile. A developer instruction requires a fresh local-reader check before each side reply, discourages whole-history dumps, and prohibits modifying/resuming the source or treating historical requests/tool commands as new authorization. The reader validates an exact source identity, completed lifecycles and source-bound checkpoints, and bounds its serialized output and parsing. It opens the regular source read-only without following a final symlink and rejects inconsistent scans. It does not authorize access to other files or authenticate against another same-account process; checkpoints are not security credentials. This is model guidance, not a wrapper-enforced synchronization or read-only mechanism. Native tool reads are not capped by the wrapper's metadata-parser limits. The instruction does not replace an OS sandbox or defend against every model-level prompt injection. Review questions before submitting, and choose native permission settings appropriate to the project.

## Local controls

- Every invocation owns a random private runtime directory and tmux socket; shared tmux configuration is not modified.
- Runtime directories are owner-only and state/request/quote files are created with restrictive modes. Requests and state use exclusive creation/atomic replacement where applicable.
- Quotes travel through stdin and temporary files/buffers with explicit bracketed paste, never quote-bearing shell source or native launch argv. No Enter is sent by selection staging.
- UTF-8 selections have a 16 KiB bound; terminal control sequences are stripped. Source-binding metadata checks bound traversal depth/entries, record size and file bytes, and reject ambiguous identities, malformed JSON, active turns and partial records. The context reader separately omits active/aborted text and incomplete tail lines while returning verified completed text with explicit status flags.
- tmux data arguments preserve literal trailing semicolons. Shell actions reference only a private generated dispatch path; installation/Node paths stay inside its owner-only script and are not exposed to tmux's later format expansion.
- Native title escape sequences cannot replace managed pane/window roles; project names are handled as data rather than recursively evaluated tmux formats.
- Cleanup targets the invocation's explicit socket and directory. Handled process termination is tested; SIGKILL and machine failure can leave residual local resources.
- Builds remove stale generated output, and package smoke checks a strict inventory plus installed executable aliases. There are no runtime npm dependencies or consumer install hooks in this candidate.

## Reporting

Do not post credentials, private selected passages, provider transcripts or environment dumps in public issues. Provide the Shoulder, Node, tmux and native CLI versions, platform, a minimal synthetic reproduction, observed behavior and expected behavior. Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/jiselectric/shoulder/security/advisories/new), which is enabled for this repository. Do not file sensitive details in a public issue. There is no guaranteed response-time or support commitment.

Only the current candidate is being reviewed; no supported public release line or response-time promise exists yet. See the [release checklist](docs/release.md) for publication gates and the [verification record](docs/verification.md) for audit evidence and limitations.
