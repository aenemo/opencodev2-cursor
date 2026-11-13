# Changelog

## 0.1.9 - 13/11/2026

### Fixed

- Open projects share one Cursor SDK worker rather than starting independent workers for each host.
- Quiet SDK runs report activity so the idle timeout does not interrupt a model that is still running. The overall turn cap still applies.
- Concurrent sessions share a pending worker connection, and concurrent model discovery requests share the same SDK request.
- Queued turns resume after tool continuations complete or their previous host disconnects. Disconnected clients are removed from pending queues.
- Cancelling a queued or replaced request cannot cancel the active replacement. Stopping the current request still cancels it.
- Non-ASCII prompts survive UTF-8 characters split across socket chunks.
- Abort listeners are removed after each SDK event and when leaving the session queue.

### Validation and limits

- 76 automated tests pass across 11 files, and the TypeScript build passes.
- Live Grok 4.7 read-tool calls and continuations passed through two local OpenCode hosts, including JSON and SSE responses, on Windows 11.
- The latest disconnect, UTF-8 and cancellation fixes have localhost integration tests with fake runners. They have not been live-tested against a second Cursor account.
- Linux, macOS, and multi-minute quiet-run behaviour have not been live-tested. Keepalives improve reliability, not model generation speed.

### Upgrading

- Run `opencode plugin update opencodev2-cursor` for an npm installation.
- Finish active chats, close all plugin hosts, including OpenChamber and OpenCode terminals, then reopen them so the shared worker loads the new runtime.
- Public plugin options and the OpenAI-compatible proxy request shape are unchanged.

## 0.1.7 - 10/11/2026

### Fixed

- Session-specific SDK locks prevent one chat's tool call from blocking another chat.
- Late tool results continue on a fresh Cursor run instead of failing the chat.
- The default idle timeout increased to 5 minutes. The overall turn cap remains 15 minutes.
