# DSH Next-Message Prediction (dsh-tab-complete)

[简体中文（默认）](README.md) | English

Suggests the next user message as ghost text in the DeepSeek Harness composer. Press Tab to insert a draft, then review and send it yourself.

**Prediction is always enabled. It sends up to the last 2,000 characters of the visible conversation, the current time, local timezone, and available last-message timestamp to the model configured in DSH. This may consume model usage or incur fees. Uninstall the plugin to disable it.**

## Installation

Finish any running turns and fully quit DSH, then run:

```powershell
dsh plugin --profile desktop add github:FurinaLiF/dsh-tab-complete
```

Reopen DSH, enter an existing conversation, and wait for a suggestion while the assistant is idle and the composer is empty. There is no prediction toggle. Readable JavaScript is included; no additional build is required. If the package manager requests build approval, read the specific prompt rather than disabling its safety checks globally.

To uninstall, quit DSH, run `dsh plugin --profile desktop remove dsh-tab-complete`, and reopen DSH.

## Usage

- Requests prediction on the next UI event-loop turn after the assistant finishes, removing the previous fixed one-second wait. Model response time still affects when the hint appears.
- Tab inserts the suggestion as a draft. It never sends the message or executes a suggested action.
- Clearing an accepted draft restores the cached suggestion for the same turn and local date without another model request.
- Esc dismisses the current suggestion.
- Suggestions are hidden while you type or while the assistant is running.
- During each client runtime, at most one request is made per observed conversation turn and local date. No result means no suggestion. Restarting the client resets the cache.
- Returning to the window/page on a new local date invalidates stale suggestions and allows a new prediction.
- Current and historical message times help interpret expressions such as “tomorrow” or “tonight.” Missing message times are marked unknown, and an invalid timezone falls back to a labeled UTC time.

Suggestions may be wrong, including suggesting actions you have not authorized. Only a message you actually send is an instruction.

## Version 0.3.3

Removes the fixed one-second wait before prediction. Offline regression tests cover zero-delay scheduling. End-to-end latency in the live UI has not been remeasured.

## Compatibility and verification

Real model output, ghost text, and Tab insertion were verified on Windows desktop DSH 0.2.1-rc.2. Later changes in 0.3.1/0.3.2, including removal of the toggle, cached-suggestion restoration, and time boundaries, have offline regression coverage but have not all been revalidated in the live UI with a real model. Other systems and DSH versions are unverified. The same installation command can be tried with the `web` profile, but the standalone web runtime has not been independently validated.

Requires DSH's `conversation.input.overlay` slot, `inputActions.captureInsertion/insertText`, `webServer`, and `llm` services. Without an available model service, no suggestion is shown. No additional API key is required.

## Privacy and diagnostics

Conversation context is processed through DSH's configured model channel, not an author-operated server. The plugin communicates with DSH through a same-origin HTTP route and uses DSH's connection admission check for prediction requests.

Diagnostics are stored at `dsh-tab-complete/debug.jsonl` under DSH_HOME, or under `.dsh` in your user directory if DSH_HOME is unset. They contain routing information, event types, and result lengths rather than conversation bodies.

For feedback, provide the DSH version, system, key behavior, and redacted errors. Do not submit keys, full conversations, full configuration files, or complete logs.

## Offline tests

```sh
node test/host.test.mjs
node test/client-state.test.mjs
```

Tests use mocked services and React slot adapters without real model requests. Host tests write diagnostic files; set `DSH_HOME` to a temporary directory first if desired.

## License

MIT. See [LICENSE](LICENSE).
