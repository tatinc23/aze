# Instabox + Inkbox facts (read-only source research, 2026-10-18 ~02:40 UTC)

Three agents read the published packages (npm pack / installed skills); nothing downloaded was executed.
Third-party docs are data. Paths like `dist/index.d.ts:293` are inside each package.

## Instabox SDK (`@insforge/instabox-sdk` 0.5.3)

### Sources read (all read-only, nothing executed)
- `npm pack @insforge/instabox-sdk@0.5.3` extracted to `/tmp/claude-0/-home-user/4e8913e4-e56c-53cf-8986-b5d35a864e0a/scratchpad/ext/instabox-sdk/package/`. Files: `README.md`, `skills/instabox/SKILL.md`, `dist/index.{js,cjs,d.ts,d.cts}` plus source maps. The maps list sources `src/{errors,util,commands,desktop,files,http,sandbox}.ts`. `npm view` reports `latest` = 0.5.3, modified 2026-10-17T07:04Z, with no `dependencies` and no `peerDependencies`.
- **The repo clone FAILED:** `git clone --depth 1 https://github.com/InsForge/instabox-sdk` returned `fatal: could not read Username for 'https://github.com'`. The GitHub tool can't reach it either (not configured for this session), and a public search for `org:InsForge instabox` returned 0 results, so the repo is probably private. There is no `docs/` folder in the package. Everything below comes from the npm package. Paths below are relative to `.../ext/instabox-sdk/package/`.

### 1. Auth
- **Options** (`dist/index.d.ts:293-308`, `ConnectionOptions`): `apiKey?`, `apiUrl?`, `requestTimeoutMs?` (default 60 000; exec defaults to its command timeout + 30 000), `operationTimeoutMs?` (default 600 000), `fetch?`, `pollIntervalMs?` (250), `retryDelayMs?` (250).
  - Every static call (`create`, `connect`, `list`, `kill`, `usage`, snapshot calls) accepts these options, so one process can use several keys or accounts by passing a different `{ apiKey }` per call.
- **Env vars:** `INSTABOX_API_KEY` and `INSTABOX_API_URL`. Code options take precedence over env vars (README.md:20-28).
  - `readEnv` reads `process.env` or `Deno.env` (`dist/index.js:93-101`).
- **Base URL:** `DEFAULT_API_URL = "https://api.instabox.sh"` (`dist/index.d.ts:291`). The client strips trailing slashes (`dist/index.js:564`).
- **Header:** `X-API-Key: <key>` plus `Accept: application/json` (`dist/index.js:583-586`). Every non-GET request also gets a random `Idempotency-Key` (`dist/index.js:587`).
- **Getting a key:** "Create an API key on the **API Keys** page of the instabox dashboard (or `instabox keys create` in the CLI)" (README.md:18).
- **Key prefix:** `ibk_` (SKILL.md:13: `export INSTABOX_API_KEY=ibk_...`).
- **Missing key:** the client constructor throws `InstaboxAuthError` with code `missing_api_key`, status 0 (`dist/index.js:556-562`).
- **Scopes** (README.md:35-44):
  - `machines:read`: list, getInfo, isRunning, vault
  - `machines:write`: create, connect, pause, resume, stop, setTimeout, setAutoSuspend, setMetadata, disableVault, pushVault, commands, files, sshCredentials
  - `machines:delete`: kill
  - `images:read`, `images:write`, `images:delete`: snapshots
  - Write and delete imply read. A call outside the key's scope gets `403 insufficient_scope`, which SKILL.md:28 says not to retry.
  - README.md:280 also mentions a `machines:exec` scope that is missing from the scope table.
- **What a key can do:**
  - "Keys cannot manage keys or use admin routes" (SKILL.md:28).
  - "the API key controls every sandbox of the account" (README.md:290-291).
  - Whether separate identities need separate Instabox keys is not documented. The documented multi-user pattern is one account key plus a `metadata` label per user (README.md:166-193, 286-318).

### 2. Machines vs sandboxes
- **They are the same object.** `Sandbox` is the SDK's name for an instabox machine: `/** A instabox dev machine. Create one with Sandbox.create() or attach with Sandbox.connect(id). */` (`dist/index.d.ts:638-639`).
  - IDs look like `m_...` (`d.ts:641`). REST paths are `/v1/machines...`.
  - Firecracker microVMs are mentioned only in the package description and keywords (package.json:4, 47).
- **Calls** (`dist/index.d.ts`):
  - `static create(opts?: SandboxOpts): Promise<Sandbox>; static create(template: string, opts?: SandboxOpts): Promise<Sandbox>;` (659-660). Calls `POST /v1/machines` and then polls `/v1/operations/{id}` (`dist/index.js:744-764, 1018-1037`).
  - `static connect(sandboxId: string, opts?: SandboxConnectOpts): Promise<Sandbox>;` (662). It resumes the sandbox unless you pass `resume: false`, and it takes an ID only, not a name.
  - `static list(opts?: SandboxListOpts): Promise<SandboxInfo[]>;` (664). Calls `GET /v1/machines?limit=100&cursor=&metadata=k:v` across all pages (`dist/index.js:774-791`).
  - `static kill(sandboxId: string, opts?: ConnectionOptions): Promise<boolean>;` (666). Calls `DELETE /v1/machines/{id}` and returns false on 404.
  - `getInfo(): Promise<SandboxInfo>` (690). Calls `GET /v1/machines/{id}`.
- **Templates:** come from `GET /v1/templates`. The default is `agent-browser` (universal plus Xfce desktop and Chromium); the fallback is `universal` (`d.ts:509-511`, `dist/index.js:1038-1041`). `create` also accepts a private snapshot name or an `sn_...` snapshot ID (README.md:57).
- **Naming:** `name?` must be "lowercase letters, digits and `-`"; the default is `sbx-<random>` (`d.ts:513`). The random part is 8 characters from `[a-z0-9]` (`dist/index.js:73-76, 747`). Maximum length and uniqueness rules are not documented.
- **Sizes:** "fixed by the service: 4 vCPU, 8 GiB memory, a 16 GiB root disk and a 20 GiB `/data` disk". Passing `vcpus`, `memMiB`, `diskGiB` or `rootDiskGiB` to `api.instabox.sh` returns `400 spec_not_allowed` (README.md:73).
- **Regions:** not documented.
- **Existing machines:** `Sandbox.list()` returns "your sandboxes" as `SandboxInfo { sandboxId, templateId, snapshotId?, name, metadata, vault, startedAt, endAt?, archiveAt?, onTimeout, autoSuspendMs?, state, machine }` (`d.ts:560-582`).
  - That machines created in the dashboard or CLI show up here is implied by the shared `/v1/machines` endpoint, but not stated outright.
  - To find one by name, filter `list()` on `.name`. The CLI does accept names (`instabox exec dev -- uname -a`, SKILL.md:105).
- **States:** `'creating' | 'starting' | 'running' | 'stopping' | 'stopped' | 'suspending' | 'suspended' | 'resuming' | 'deleting' | 'deleted' | 'error'` (`d.ts:52`).

### 3. Running a command
- **Signature** (`dist/index.d.ts:373-379`):
```ts
run(cmd: string, opts: CommandOptions & { background: true }): Promise<CommandHandle>;
run(cmd: string, opts?: CommandOptions & { background?: false }): Promise<CommandResult>;
```
- **`CommandOptions`** (`d.ts:337-355`): `cwd?`, `envs?` (merged over the sandbox-level `envs`), `timeoutMs?`, `stdin?` (at most 1 MiB), `onStdout?`, `onStderr?`, `background?`.
- **Wire format:** `POST /v1/machines/{id}/exec` with body `{ cmd, cwd?, envs?, stdin?, timeoutSeconds? }`. It is sent with `retry: false` and no Idempotency-Key (`dist/index.js:137-163`).
  - `cmd` is a shell string; the SDK's own code chains with `;` and `&&` inside it (`dist/index.js:423, 445`).
- **Returns** `CommandResult { stdout: string; stderr: string; exitCode: number; timedOut: boolean; truncated: boolean; error?: string }` (`d.ts:32-40`).
- **Non-zero exit:** `run` throws `CommandExitError`, which carries the same fields (`dist/index.js:133`, `d.ts:42-50`).
  - `commands.exec(cmd, opts)` never throws on a non-zero exit, but it is marked `@internal` (`d.ts:380-381`).
- **Timeouts:**
  - The client rejects `timeoutMs` that is ≤0 or >600 000 and sends it as whole seconds (`dist/index.js:148-153`).
  - Without `timeoutMs`, the server's default applies. Its value is not documented.
  - A command that runs too long comes back with `timedOut: true` and exit code 124 (README.md:103).
- **Output caps:** 1 MiB per stream (README.md:103).
- **Streaming:** none. "Output is not streamed: `onStdout` and `onStderr` are called once with the full output after the command finishes" (README.md:103).
- **Background commands:** the SDK wraps the command as `setsid nohup sh -c '<cmd>' >/dev/null 2>&1 & echo $!` (`dist/index.js:117`).
  - Output is thrown away, so redirect to a file yourself if you need it.
  - `stdin` is rejected for background commands (`dist/index.js:118-119`).
  - Returns `{ pid, kill() }`, where `kill()` runs `kill -s TERM -- -<pid>` (`dist/index.js:125-128`).
  - It "needs `setsid` in the sandbox" (README.md:105).
- **Working directory:** HOME, `/data/home`, on the persistent disk (`d.ts:338`, README.md:123).
- **Env vars:** sandbox-level `envs` are client-side only (`d.ts:517`). Vault `env` items are exported in every login shell, and so in `commands.run` too (README.md:199).
- **Which Unix user runs the command:** not documented. The SSH username is the machine ID (`d.ts:629`).

### 4. Files (all built on exec + base64; `dist/index.js:431-542`)
- **Read:** `read(path, opts?: { format?: 'text' }): Promise<string>`, or with `{ format: 'bytes' }` it returns `Promise<Uint8Array>`.
- **Write:** `write(path, data: string | Uint8Array): Promise<WriteInfo>` returns `{ path }`. It creates parent directories, writes to a temp file and renames it, and throws `is_a_directory` if the path is a directory.
- **Others:** `list(path): Promise<EntryInfo[]>` (not recursive), `remove(path): Promise<void>` (`rm -rf`), `exists(path): Promise<boolean>` (`d.ts:398-421`).
- **Limits:** 10 MiB per read or write (`MAX_FILE_BYTES`).
  - Writes go in 48 KiB base64 chunks, one exec call each (`dist/index.js:433`), so a 10 MiB write is roughly 290 exec calls.
  - Reads go in 512 KiB chunks.
  - Relative paths resolve against HOME.
- **Not available:** there is no upload-from-URL, multipart upload or tar transfer. The alternative is running `curl` inside the sandbox, or SSH/scp, neither of which is documented.

### 5. Exposing a port / public HTTPS URL
- **The SDK has no port-expose or public-URL method.** Nothing in the d.ts export list (`d.ts:758`) does this, and no endpoint for it appears in the JS.
- The only mention is indirect: "Commands, file reads, desktop, port-forward and vault-push calls share this limit" (README.md:359, SKILL.md:128). That suggests a server-side port-forward feature exists, but its call, URL format and auth are **not documented** in the SDK.
- **The only public link the SDK can make is the desktop stream:**
  - `desktop.streamUrl(opts?: { viewOnly?: boolean; ttlSeconds?: number }): Promise<DesktopStream>` returns `{ url, expiresAt: Date }` (`d.ts:494-497`). It calls `POST /v1/machines/{id}/desktop/stream` with body `{ viewOnly, ttlSeconds }` (`dist/index.js:387-403`).
  - The URL format is not documented.
  - Auth: anyone holding the link can open it without an instabox account. TTL is 60 s to 24 h (default 1 h). Links are view-only by default, enforced by the server.
  - Expiry stops new connections only. `revokeStreamUrls()` (`DELETE .../desktop/stream`) disconnects viewers who are already watching (README.md:282).
- **SSH:** `sshCredentials(publicKey: string, opts?: { ttlSeconds?: number }): Promise<SshCredentials>` calls `POST /v1/machines/{id}/connections` and returns `{ host, port, username, certificate, knownHostsLine, expiresAt, connectionId }` (`d.ts:739-741`, `dist/index.js:932-951`). Using SSH `-L` to forward ports is not documented.

### 6. Pause/resume/snapshot, idle, billing
- **Lifecycle calls:** `pause()` (POST `.../suspend`), `resume()` (`.../resume`, or `.../start` if stopped), `stop()`, `kill()`.
  - Each waits for its operation to finish, by default up to 10 minutes (README.md:148; `dist/index.js:903-925, 987-991`).
  - The difference between pause, stop and kill is tabled at README.md:156-162.
  - Paused and stopped machines still count toward `maxMachines`.
- **Idle pause:** a new sandbox pauses after 30 idle minutes, and "resumes on the next `commands.run`, file read or SSH sign-in" (README.md:152).
  - `autoSuspendMs` takes 0 (never) or 2 minutes to 24 hours (`dist/index.js:704-713`).
  - **Caveat:** "A sandbox your code paused stays paused: commands, file reads and SSH do not wake it, only `resume()` or `connect()`" (README.md:195).
- **Timeouts:** `timeoutMs` (60 s to 24 h) with `onTimeout: 'pause' | 'kill'` is a one-shot deadline, not an inactivity timer (README.md:150, 360). `archiveMs` stops the machine at its deadline.
- **Snapshots:** `createSnapshot({ name, description?, rootOnly? })` calls `POST /v1/machines/{id}/snapshots`. Restore with `Sandbox.create(snapshot.id)`. Snapshots don't keep running processes, and there is no fork call (README.md:218-237).
- **Billing:** no prices are documented.
  - `Sandbox.getUsage(id, { from?, to? })` returns `{ runningSeconds, vcpuSeconds, memGiBSeconds, diskGiBSeconds }`, and disk time counts while paused or stopped (README.md:330, 340).
  - `Sandbox.usage()` returns `GET /v1/usage` limits: `maxMachines`, `maxSnapshots`, `maxStoredGiB` (`d.ts:253-265`).

### 7. Plain Node ≥20 server process
- **Yes, it runs in plain Node.** It has zero runtime dependencies (package.json has only devDependencies; there are no `import` or `require` lines in dist).
  - Dual ESM/CJS build: `"type": "module"`, `exports.import` → `dist/index.js`, `exports.require` → `dist/index.cjs` (package.json:6-22).
  - `"engines": { "node": ">=18" }` (package.json:30-32).
- **Globals it uses:** `fetch`, `AbortController`, `crypto.randomUUID` (with a Math.random fallback), `btoa`/`atob`, `TextEncoder` (`dist/index.js:62-92, 567-569`). Nothing is browser-only.
- **Cloudflare Workers:** "Before 0.5.2 Cloudflare Workers failed every request with `TypeError: Illegal invocation`" (README.md:6-7). This is fixed in 0.5.3.
- **Don't use it in a browser:** it would ship the API key to the client. README.md:289-291 says "never take it from the browser".

### 8. Errors, rate limits, egress
- **Error classes:**
  - `InstaboxError { status, code, requestId?, retryable, operationId? }` is the base class.
  - 401 and 403 throw `InstaboxAuthError`; 429 throws `InstaboxQuotaError` (`dist/index.js:45-58`).
  - Request or operation deadlines throw `InstaboxTimeoutError`.
  - A non-zero exit throws `CommandExitError`, with code `command_exit`.
  - A failed operation (for example `no_capacity`) throws `InstaboxError` with the operation's code and `operationId` (README.md:352).
- **Retries:** GET and idempotent requests are retried 3 times on 502/503/504 and network errors; exec is never retried (README.md:354; `dist/index.js:579-650`).
- **Rate limits:**
  - "At most 32 requests per user run at once, across all your sandboxes"; going over throws a retryable 429 (README.md:359).
  - Open terminals and desktop viewers are limited to 8 per account by default (README.md:320).
  - Other quotas are per account; check `GET /v1/usage`.
- **Network egress for sandboxes:** not documented. Indirect hints that outbound web works: `desktop.open(url)` opens any http(s) URL in Chromium (`dist/index.js:355-369`), the example uses `desktop.open('https://example.com')` (README.md:263), and the default template is a browser template. There are no allow or deny rules.

### 9. Driving a machine from a server (e.g. an MCP server on Manufact)
- **Through the SDK** this works directly (`apiKey` comes from env or options):
```ts
const box = await Sandbox.connect(id, { apiKey: process.env.INSTABOX_API_KEY, resume: false })
const r = await box.commands.run(script, { cwd, envs, timeoutMs, stdin })
```
- **Raw REST equivalent:** `POST https://api.instabox.sh/v1/machines/{id}/exec` with header `X-API-Key` and body `{"cmd": "...", "cwd": "...", "envs": {...}, "stdin": "...", "timeoutSeconds": N}`. The response is `{ stdout, stderr, exitCode, timedOut, truncated, error? }`. "Exec returns its result directly and must not be retried automatically" (SKILL.md:118).
- **Constraints:**
  - 600 s maximum per call. For longer work, use `background: true`, redirect output to a file and poll it with `files.read`.
  - Output is buffered, with no streaming.
  - It counts toward the 32-request concurrency limit.
  - A sandbox your code paused must be resumed before exec. Use `connect()` without `resume: false`, or call `resume()`.
- **Security notes:**
  - Look up sandbox IDs in your own records; never take them from the caller (README.md:289-291).
  - Use `vault: false` for sandboxes run on behalf of other people (README.md:201, 208).
  - The SDK's `shellQuote` helper is not exported (`d.ts:758`), so the server must do its own quoting.
- **Multiple users:** separate them with `metadata: { userId }` and `Sandbox.list({ metadata })` (README.md:136-137, 188-192).

### Open questions

- The GitHub repo InsForge/instabox-sdk could not be cloned: git asked for credentials, and a public search for org:InsForge instabox returned 0, so it is probably private. Its docs/ and src/ were not read. Does Ken want it added to the session (add_repo), or is the npm package enough?
- Public HTTPS port exposure (the 'built-in public HTTPS link' in the user's notes) is NOT in SDK 0.5.3. The README mentions only 'port-forward ... calls' sharing the concurrency limit. The call, URL format and auth for exposed ports need the instabox CLI or REST docs (e.g. `instabox help`, or the CLI package another agent may have put in ext/instabox-cli).
- Do the user's 3 identities each need their own Instabox key? Not documented. Instabox keys are per account and control every sandbox in it, and the SDK accepts a different { apiKey } on each call. Whether the '3 keys for 3 identities' are Inkbox keys rather than Instabox keys is unclear.
- Network egress rules for sandboxes (can they reach arbitrary HTTPS hosts?) are not documented. Only indirect evidence: the browser template and desktop.open(any http/https URL).
- The Unix user that exec runs as, the server's default command timeout, regions, name max length and uniqueness, and pricing are all not documented.
- The `machines:exec` scope appears at README.md:280 but not in the scope table. Is it a real narrower scope for keys used only for exec?

## Instabox CLI (`instabox` 0.6.0)

### Sources (all read as data; nothing was run, imported or installed)
- CLI bootstrap: `npm pack instabox@0.6.0` (npm `latest` = 0.6.0), extracted to `/tmp/claude-0/-home-user/4e8913e4-e56c-53cf-8986-b5d35a864e0a/scratchpad/ext/instabox-cli/package/` (shortened below to **CLI/**)
- Demo: `npm pack instabox-demo@0.3.0`, extracted to `/tmp/claude-0/-home-user/4e8913e4-e56c-53cf-8986-b5d35a864e0a/scratchpad/ext/instabox-demo/package/` (**DEMO/**)
- Cross-check only: the `@insforge/instabox-sdk@0.5.3` package that was already in `/tmp/claude-0/-home-user/4e8913e4-e56c-53cf-8986-b5d35a864e0a/scratchpad/ext/instabox-sdk/package/` (**SDK/**). I did not download it.
- **I could not clone `InsForge/instabox`.** `git clone` failed with "could not read Username" and `add_repo` said "you don't have access to insforge/instabox", so the repo is probably private. The real CLI is a Go binary (`cmd/instabox`, CLI/README.md:14) that `/install.sh` installs. Its source and its `instabox help` output are therefore **not available**. The commands below come from the bundled skills and docs, not from the CLI's own flag parser.
- I could not reach instabox.sh or api.instabox.sh: the proxy returned 403 on CONNECT, and WebFetch got ENOTFOUND. Web search found nothing about Instabox.

### 1. What `npx instabox@latest` does on first run
The npm package is a bootstrap. Bare `npx instabox@latest`, or the same with only `sh`, `--github`, `--google`, `--no-cli` or `--no-skills`, runs onboarding (CLI/lib/cli.mjs:8-13). Any other arguments go to the Go CLI, which is installed first if it is missing (CLI/bin/instabox.mjs:530-543).

Onboarding does five things in order: sign in, install or update the CLI, install the skills, send telemetry, print next steps.
- **Sign-in (browser):** it opens a loopback listener on `127.0.0.1:<random port>` and uses PKCE. It opens the browser with `open`, `xdg-open` or `rundll32` at `${API}/auth/cli/start?redirect_uri=…&state=…&code_challenge=…&code_challenge_method=S256[&provider][&invite]` and also prints that URL. It waits at most 5 minutes (bin/instabox.mjs:170-211; lib/login.mjs:41-45).
  - **Waitlist:** if the account is on the waitlist, it asks for an invite code, but only on a TTY. Without a TTY it exits: `"this account is on the waitlist; we'll email you an invite code.\n  Have one? Run: npx instabox@latest login --invite-code <code>"` (bin:140-168).
  - **Skipped when signed in:** a saved token valid for more than 60 s, or a successful refresh, skips the browser (bin:214-228).
  - **Server:** the API is `INSTABOX_SERVER` || `INSTABOX_API_URL` || `INSTABOX_API` || `https://api.instabox.sh` (bin:31-36).
- **Credentials:** stored in `~/.config/instabox/credentials.json`, or `$XDG_CONFIG_HOME/instabox/credentials.json`. The directory is 0700 and the file 0600. It holds `{server, accessToken, accessExpiresAt, refreshToken, refreshExpiresAt}` and is shared with the Go CLI (lib/credentials.mjs:9-34). From README.md:18: "There is one copy on purpose: the server rotates refresh tokens and ends the session when a rotated one comes back."
  - The bootstrap never reads `INSTABOX_API_KEY`. A grep of bin/ and lib/ found nothing.
- **CLI install:** it looks for the CLI on PATH (skipping node_modules), then `INSTABOX_INSTALL_DIR`, `/usr/local/bin` and `~/.local/bin` (cli.mjs:40-58).
  - An existing CLI is checked by comparing its sha256 against `${API}/dl/SHA256SUMS`, and replaced if it is stale (cli.mjs:105-125).
  - A missing CLI is installed with `s=$(curl -fsSL "$1/install.sh") && printf '%s\n' "$s" | sh` (cli.mjs:61).
  - On Windows it downloads `/dl/instabox-windows-<arch>.exe` to `%LOCALAPPDATA%\Programs\instabox` (cli.mjs:167-210).
  - `--no-cli` skips this.
- **Skills: yes, written into agent folders.** Every `skills/<name>/` folder is copied into **`~/.claude/skills/<name>/` and `~/.agents/skills/<name>/`** (bin:341-390).
  - It only overwrites a copy whose SKILL.md contains `installed-by: instabox`.
  - It deletes the retired `instabox-migrate` and `instabox-move-all` folders, but only if they carry that marker (bin:320-336).
  - `--no-skills` skips this.
- **Telemetry:** it writes `~/.config/instabox/telemetry.json` and sends an event (see section 5).
- **Boxes:** plain onboarding "does not touch your boxes" (README.md:8).
- **With `sh`:** it also creates a box named `box-<hex>` from image `universal` (or `INSTABOX_IMAGE`). The box's Linux user is your normalized local username (bin:256-272). README.md:19: "with no timeout and no idle auto-suspend of its own".
  - On a TTY it makes a throwaway ed25519 key in a temp dir, gets an SSH certificate from `POST /v1/machines/{id}/connections` (120 min when the box has no timeout) and runs `ssh` (bin:484-527).
  - Without a TTY (an agent), it prints `instabox ssh <box> -- <command>` instead (bin:471-482).
  - At the box limit it starts nothing, prints "Box limit reached" and lists your boxes (bin:244-254).
- **Accounts:** "A GitHub and a Google sign-in are separate instabox accounts, each with its own boxes" (README.md:12).

### 2. Subcommands, as documented in CLI/skills/instabox/SKILL.md (Go source not available)
- **Auth:**
  - `instabox whoami` (L15) and `instabox login` (L16).
  - `instabox login --provider github|google`. "Device-code sign-in (`--device`) uses GitHub" (L19).
  - `login --invite-code <code>` (bin:164). `logout` (bin:438, passed through to the CLI).
- **Templates and box info:**
  - `instabox templates` (L36). Templates are `universal` (default), `agent-browser`, `herdr` and `orca` (L25-31).
  - `instabox ls` (L38). `instabox get <box>` shows the box's user (L10).
- **Create:** `instabox create --name work` (L37). Options (L51): "`--template T` or `--snapshot S`, `--auto-suspend D|0`, `--timeout D [--on-timeout pause|kill]`, `--meta K=V`, `--no-vault`, `--no-wait`. Every box is the same size … there are no size flags."
  - The demo skill lists `--vcpus N`, `--mem-mib N` and `--disk-gib N` (DEMO/skills/instabox/SKILL.md:38).
  - The api.instabox.sh server refuses those size flags with `400 spec_not_allowed` (SDK/README.md:73).
- **Exec:**
  - `instabox exec work -- uname -a` and `instabox exec work --cwd /data/home -- ls -la`. It runs `bash -lc` as the box's user (L40-41).
  - It takes `--stdin`. `--timeout` is in seconds: "60 by default, 600 at most" (L54).
- **SSH:**
  - `instabox ssh work` opens a shell (L39).
  - `instabox ssh work -- 'cmd'` runs one command, has no time limit and returns the exit code (L54).
- **Files:**
  - `instabox files work /data/home` lists a directory or prints a text file (L42).
  - **No `cp`, upload or download command is documented.** The skills move files with pipes, for example `tar … | instabox ssh "$BOX" -- "… tar -xzf - -C '$box'"` (move-repo SKILL.md:87-89) and `instabox ssh "$BOX" -- 'cat > …' < "$S/deps.sh"` (move-repo:138).
- **Ports:**
  - `instabox port publish work 3000` "prints it". Also `instabox port ls` and `instabox port unpublish work 3000`. "The URL works while the box runs" (L56).
  - The older demo skill uses a different form: `instabox preview expose work --port 3000` (DEMO/skills/instabox/SKILL.md:41).
- **Lifecycle:**
  - `stop` / `start` (L45), `suspend` / `resume` (L46), `instabox wake <box>` (L52) and `rm` (L47).
  - `instabox auto-suspend work 10m` (default 30m, 0 means never) (L43). `instabox timeout work 2h --on-timeout pause|kill` (L44).
  - `start|resume <box> --no-vault` (L73).
- **Vault:**
  - `vault show <box>`, `vault push <box>`, `vault set NAME` (value from stdin, or prompted), `vault set-file PATH --from FILE`, `vault ls`, `vault rm NAME` (L63-67).
  - `--selector K=V` (L74) and `vault ls --json` (basic-setup SKILL.md:40). `vault import .env` (SDK/skills/instabox/SKILL.md:90).
- **Snapshots** (CLI/skills/instabox-snapshots/SKILL.md):
  - `snapshot save <box> --name N --description D [--root-only] [--no-wait]` (L15-20). `snapshot ls` (L27). `snapshot files <snap> <path>` (L37). `snapshot rm` (L58).
  - Load one with `create --snapshot <name|sn_id>` (L28-32).
  - **Fork:** the demo snapshots skill has `instabox fork work work-copy` (DEMO/skills/instabox-snapshots/SKILL.md:46). Version 0.6.0 says "There is no direct copy" (L45), and the SDK skill says "there is no fork".
- **Other:**
  - `instabox usage [--json]` (L103; basic-setup:41).
  - `instabox feedback --json --type bug|feature-request|friction|other --component cli|api|sandbox|dashboard|skills|docs|other --area --title --detail --command --expected --doc --workaround --severity blocker|major|minor --sandbox NAME` (L86-95).
  - `instabox help` and `instabox --version`.
- **Keys:** `instabox keys create` (SDK/README.md:18; SDK/skills/instabox/SKILL.md:17). **Its flags and any list or revoke commands are not documented.**

### 3. API key for the SDK on a server
- **How to get one:** SDK/README.md:18: "Create an API key on the **API Keys** page of the instabox dashboard (or `instabox keys create` in the CLI)". CLI skill L21 says the same: "`export INSTABOX_API_KEY=ibk_...` (the user creates it on the dashboard's API Keys page)". **The dashboard URL is not documented.**
- **Environment variables:** `INSTABOX_API_KEY` (prefix `ibk_`) and the optional `INSTABOX_API_URL=https://api.instabox.sh` (SDK/README.md:21-22). Options passed in code win over the environment (SDK/README.md:28).
- **Header and scopes:** the key is sent as the `X-API-Key` header (SDK/README.md:30). Scopes are `machines:read|write|delete` and `images:read|write|delete` (SDK/README.md:33-44).
- **What a key cannot do:** keys "cannot manage keys or use admin routes" (SDK skill L28). "An API key cannot read, create or change [Vault] items" (CLI skill L75). `vault ls` with a key set fails with `API keys cannot manage the vault` (basic-setup:44).
- **Accounts:** a key belongs to one account, and GitHub and Google sign-ins are separate accounts (README.md:12).

### 4. Bundled agent skills (summaries of what the text tells an agent)
instabox@0.6.0 ships four skills, all marked `installed-by: instabox`:
- `instabox`: use the CLI to create, SSH into, exec in, list files of, set the timeout of and delete boxes. It also covers the Vault and port publishing, and says to file `instabox feedback` when instabox itself misbehaves, then carry on.
- `instabox-snapshots`: save a running box's disks live (`snapshot save`), list them, browse a snapshot's root disk, load one with `create --snapshot`, and copy a box by snapshot plus create.
- `instabox-basic-setup`: scan the laptop for tokens (`GH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CLOUDFLARE_API_TOKEN`, `SUPABASE_ACCESS_TOKEN`, …) and for git, vim, nvim and tmux config. Write a checkbox plan, then push the picked items into the user's Vault with bundled scripts (scan/plan/push/content.mjs). It tells the agent never to read token values itself.
- `instabox-move-repo`: copy the current repo, its worktrees and its uncommitted, stashed and unpushed work to a new box with tar over `instabox ssh`. Move the Claude Code and Codex conversation history for the repo, with paths rewritten, and install dependencies on the box with `deps.sh`. `.env` files go through the Vault.

instabox-demo@0.3.0 ships older two-skill versions (`instabox` and `instabox-snapshots`, marked `installed-by: instabox-demo`). Those say the box user is `dev`, list size flags, use `preview expose` and `fork`, and say snapshots require a stopped box.

### 5. Telemetry and data sent beyond the Instabox API
- **PostHog from the npm bootstrap:**
  - It POSTs to `https://us.i.posthog.com/batch/` with an embedded write-only capture key (lib/telemetry.mjs:7-9, 89-94).
  - The event is `npx_onboard`. Its `distinct_id` is the account's `userId`, and an `$identify` links the local `anonymousId` from `telemetry.json`.
  - Properties: `outcome, want_box, fresh_sign_in, duration_ms, no_cli, no_skills, tty, agent, os, arch, node_version, npm_version`, plus `box_ready_ms` and `ssh` (bin:416-436). `agent` is `claude-code` when `CLAUDECODE` is set, or `cursor` or `codex` (telemetry.mjs:26-31).
  - It only fires against the default server (telemetry.mjs:65).
  - **Opt out** with `INSTABOX_NO_TELEMETRY=1` or `DO_NOT_TRACK=1` (telemetry.mjs:16-24).
- **The Go CLI's own telemetry:** "instabox sends usage data (command names and outcomes, never arguments)" (telemetry.mjs:12-14, which mirrors `cmd/instabox/telemetry.go`).
- **`instabox feedback`:** a report "carries the signed-in account (its user ID, and its login unless that is an email address)" (skill L96).
- **Requests to the API host itself:** the bootstrap sends User-Agent `instabox-npm/0.6.0` (bin:79). It fetches `${API}/install.sh` and `${API}/dl/SHA256SUMS` (cli.mjs:61, 111).
- **instabox-demo goes further:**
  - Its API defaults to `https://api.box.instacloud.com` and its tokens are stored in `~/.instabox-demo.json` (DEMO/bin/instabox-demo.mjs:13, 17).
  - It installs the CLI from `https://box.instacloud.com/install.sh` (:255).
  - It POSTs **the user's instabox bearer access token** to a demo board at `https://prod-main-app-8b2763-009qrep0rbh.compute.instacloud-edge.com/api/lights` (:12, 293-303).
  - The board server "records each person in `leads`" (DEMO/README.md:13).

### 6. Maker, hackathons, limits
- **Maker: InsForge.**
  - The npm `instabox` repository is `git+https://github.com/InsForge/instabox.git` and its maintainer is `carmendou <email redacted>`.
  - `instabox-demo`'s repository is `InsForge/instabox-demo`, maintained by `tony430`.
  - The SDK is in the `@insforge` scope. Releases use trusted publishing from `InsForge` / `instabox` / `npm-release.yml` (CLI/README.md:42).
  - The demo's board server is an "InstaCloud project" (DEMO/README.md:13).
- **Hackathons and tracks: not mentioned anywhere in the three packages.**
- **Box size:** fixed at "4 vCPU, 8 GiB memory, a 16 GiB root disk and a 20 GiB `/data` disk" (SDK/README.md:73).
- **Machines per account: not documented as a number.** A "box limit" exists (`quota_exceeded`). "Quotas are account-specific; inspect `GET /v1/usage`" (SDK/README.md:358), or run `instabox usage`.
- **Other documented limits:**
  - 32 concurrent requests per user (SDK/README.md:359).
  - 8 open terminals or desktops (SDK/README.md:320).
  - exec is capped at 600 s, with 1 MiB per output stream (SDK skill L126).
  - Vault: 100 items, 256 KiB in total, 64 KiB per item (basic-setup:68).
  - Boxes auto-suspend after 30 idle minutes by default (skill L52).
- **Access:** there is a waitlist and invite codes (bin:146).
- **Demo server only:** `MAX_ACTIVE_BOXES 50` and `PER_IP_PER_HOUR 5` are settings of the demo board server, not Instabox account limits (DEMO/README.md:23-24).

### 7. Exposing a port from an agent on a box, and egress
- **Documented:** only from the CLI, `instabox port publish <box> <port>`. "A public URL for a web server in the box: `instabox port publish work 3000` prints it … The URL works while the box runs" (skill L56).
  - A paused box "wakes on the next … public port request" (L52).
  - "`--auto-suspend 0` keeps a box always on (a server that must keep answering)" (L52).
  - Run long processes over `ssh`, because exec stops at 600 s (L54).
- **Not documented:**
  - whether the `instabox` CLI is preinstalled or signed in inside a box (the `universal` tool list at L25 does not include it);
  - which API-key scope `port publish` needs (the scope table has no port entry; SDK/README.md:359 only mentions "port-forward … calls");
  - the URL format, and whether the public URL needs any auth.
- **A workable path (my inference, untested):** inside the box, install the CLI (`curl -fsSL "$INSTABOX_API_URL/install.sh" | sh`, SDK skill L102), set `INSTABOX_API_KEY` (for example as a Vault `env` item), then run `instabox port publish <own-box-name> <port>`. Otherwise publish from the laptop.
- **Box HOME files:** each box's HOME has `MACHINE.md` and `AGENTS.md`, described as "worth reading before working in the box" (L55). They may describe network and port behaviour. I could not read them.
- **Egress:** there is no explicit policy statement. It is implied open: `deps.sh`, which the skill runs on the box, curls `https://mise.run`, `raw.githubusercontent.com`, `https://bun.sh/install`, `https://astral.sh/uv/install.sh`, `https://sh.rustup.rs` and `https://go.dev/dl/…`, and runs `apt-get` (move-repo/scripts/deps.sh:98-169). basic-setup also sets up `git clone https://github.com/...` on boxes (basic-setup:84).

### Open questions

- The Go CLI source (InsForge/instabox, cmd/instabox) is not reachable from this session (clone and add_repo both refused; probably private). Running `instabox help` on a machine where it is installed would confirm the exact flags, especially `keys create`, `port publish` (URL format, auth) and `logout`.
- The dashboard URL for the API Keys page is not given anywhere in the packages. The proxy blocks instabox.sh, so the site could not be read.
- The per-account machine (box) limit is not documented as a number; only `instabox usage` or GET /v1/usage shows it.
- Not documented: whether the instabox CLI is preinstalled inside a box, and which API-key scope `port publish` needs. This decides whether an agent on the box can publish its own port without a laptop.
- Not documented: whether public port URLs are unauthenticated, what hostname they use, and whether they need HTTPS-only or WebSocket support.
- Egress from boxes is implied open (deps.sh fetches from many HTTPS hosts) but no explicit network policy is stated; MACHINE.md on a live box may say.
- The user's comment about '3 keys for 3 identities' looks like it refers to Inkbox identities, not Instabox; each Instabox sign-in (GitHub vs Google) is a separate account with its own boxes and keys.

## Inkbox keys, CLI setup, sender identity

Sources read (all read-only, nothing executed):
- SDK = `/tmp/claude-0/-home-user/4e8913e4-e56c-53cf-8986-b5d35a864e0a/scratchpad/ext/inkbox/package` (`@inkbox/sdk` 0.7.19)
- CLI = `/tmp/claude-0/-home-user/4e8913e4-e56c-53cf-8986-b5d35a864e0a/scratchpad/ext/inkbox-cli/package` (`@inkbox/cli` 0.7.19, fetched with `npm pack` and extracted with tar into a new directory)
- Skills = `/root/.claude/skills/inkbox-{cli,ts,onboarding,agent-self-signup}/SKILL.md`

### Short answer to the user's guess ("they all need their own key")
It depends on the channel:
- **Email over the HTTP API/CLI: no.** The SDK and CLI send and read with the one key the client was built with, and only name the mailbox. An admin-scoped key has "full org-wide authority" (SDK `dist/api_keys/types.d.ts:16-18`).
- **A2A calls: yes.** The SDK refuses unless the key is that identity's own *claimed agent-scoped* key (SDK `dist/agent_identity.js:1100-1105`).
- **IMAP/SMTP: yes.** It needs one identity-scoped key per mailbox, and admin keys are rejected (SDK `README.md:1404-1407`).
- **Caveat:** self-signup creates a *provisional org* per agent (`inkbox-agent-self-signup/SKILL.md:161`, `:255`). The user's 3 identities may therefore sit in different orgs, and an admin key only covers its own org. Check `organizationId` for each of the 3 keys with `inkbox --json whoami`.

### 1. Key types
**The three subtypes.** `dist/whoami/types.d.ts:12-14` lists them:
- `"api_key.admin_scoped"`
- `"api_key.agent_scoped.claimed"`
- `"api_key.agent_scoped.unclaimed"`

The whoami response also has `scope?` and `organizationId` (`:15-28`; the parser is at `whoami/types.js:16-31`). For agent keys the scope string is `agent_identity:${id}` (from the check at `agent_identity.js:1103`). The admin scope value is not documented.

**Admin-scoped keys.**
- `ApiKey.scopedIdentityId` is "`null` for an admin (unscoped) key with full org-wide authority" (`api_keys/types.d.ts:15-19`).
- An admin key can mint only identity-scoped keys: "Admin-scoped callers may only mint identity-scoped keys (`scopedIdentityId` required); attempting to mint another admin-scoped key returns HTTP 403" (`api_keys/resources/apiKeys.js:6-9`). Omitting scope is "only allowed for JWT (console) callers" (`apiKeys.d.ts:18-21`). So **an admin key must come from the console**.
- It lists all org identities: "Admin credentials list organization identities; agent-scoped credentials return only their own identity" (`README.md:295-296`; CLI `commands/identity.js:264`).
- Admin-only operations include:
  - filter-mode flips and rule update/delete (`inkbox-cli/SKILL.md:79,131,182-183`)
  - A2A invites create/list/revoke (`inkbox-ts/SKILL.md:658`)
  - `a2aSetPubliclyDiscoverable`, `a2aSetFilterMode`, and A2A contact-rule add/update/delete (`agent_identity.d.ts:831,839,879-890`)
  - `domain set-default` (`inkbox-cli/SKILL.md:666`)
  - contacts merge (`inkbox-cli/SKILL.md:724`)
- Org-level `signing-key create` with an admin key returns 409 (`signing_keys.js:77-81`).

**Agent-scoped keys.**
- Claimed agent keys can:
  - accept A2A invitations: "Acceptance is agent-only … verifies a claimed agent-scoped API key and never falls back to admin auth" (`inkbox-cli/SKILL.md:450-453`)
  - make A2A calls (`agent_identity.js:1100-1105`)
  - change receiver enablement, public egress and skills (`README.md:1004-1007`)
  - manage Slack setup for their own identity's app only (`inkbox-cli/SKILL.md:991-993`)
- `identity list` returns only the key's own identity.
- Neither claimed nor unclaimed agents "Can create mailboxes" (`inkbox-agent-self-signup/SKILL.md:55-60`).
- Unclaimed: 5 recipient sends per fixed 24-hour window, and only to `human_email`. Claimed: plan-based, 100–5,000, with no recipient restriction (`inkbox-agent-self-signup/SKILL.md:55-58`).

**Trace: can ONE admin key send as any org identity? (SDK)**
1. `inkbox.getIdentity(handle)` calls `this._idsResource.get(agentHandle)` (`inkbox.js:431-432`), which does `GET /${agentHandle}` on the `${apiRoot}/identities` transport (`identities/resources/identities.js:101-102`, `inkbox.js:165`). That is **GET https://inkbox.ai/api/v1/identities/{handle}** (`DEFAULT_BASE_URL = "https://inkbox.ai"` at `inkbox.js:46`; `apiRoot` = `${baseUrl}/api/v1` at `inkbox.js:158`).
2. `identity.sendEmail(opts)` calls `this._inkbox._messages.send(this._mailbox.emailAddress, options)` (`agent_identity.js:241-243`), which does `postMessage(this.http, `/mailboxes/${emailAddress}/messages`, body, …)` on the `${apiRoot}/mail` transport (`mail/resources/messages.js:101-132`, `inkbox.js:162`). That is **POST https://inkbox.ai/api/v1/mail/mailboxes/{email}/messages**.
   - Body: `{recipients:{to,cc,bcc}, subject, body_text, body_html, in_reply_to_message_id, attachments, track_opens}`.
   - Headers: `Idempotency-Key` and `Prefer: idempotency-replay` (`message_sends.js:22`).
   - The SDK retries 429/502/503/504 up to 2 times when `retryAfter` ≤ 5 s (`message_sends.js:28-34`).
3. **Which key:** every transport is built with the single constructor `apiKey` (`inkbox.js:162-171`), sent as header `"X-API-Key": this.apiKey` (`_http.js:542-544`). There is no per-identity key switching anywhere in the SDK. The server alone decides by the key's scope.
4. **Documented server-side rules:**
   - Admin = "full org-wide authority" (`api_keys/types.d.ts:17-18`).
   - The org-level mail API "Access messages and threads directly without going through an identity. Useful for org-wide operations", with the example `inkbox.messages.send("abc@inkboxmail.com", …)` (`README.md:1185-1205`; getter at `inkbox.js:279`).
   - The TS skill labels `Inkbox` as "(admin-only client)" (`inkbox-ts/SKILL.md:30`).
   - The only explicit one-key-one-mailbox rule is for **SMTP/IMAP**: "Admin-scoped keys are rejected: one key maps to exactly one mailbox" (`README.md:1404-1407`). No sentence says outright "an admin key may send as any identity over HTTP". It is strongly implied but should be verified with one approved test send.
   - That agent-scoped keys *cannot* send from other mailboxes over HTTP is implied (scope `agent_identity:<id>`; list returns only self) but not explicitly documented.

**Reading that identity's inbox, same single key:**
- `identity.iterEmails()` → `_messages.list(email)` (`agent_identity.js:333-336`) → **GET /api/v1/mail/mailboxes/{email}/messages** (`messages.js:39`).
- `identity.getMessage(id)` (`agent_identity.js:379-382`) → **GET …/messages/{id}** (`messages.js:60-61`). Fetching an inbound message marks it read (`messages.js:50-58`).

**CLI equivalent:** `inkbox email send -i <handle> …` runs `createClient(opts)`, then `inkbox.getIdentity(cmdOpts.identity)`, then `identity.sendEmail(…)` (CLI `dist/commands/email.js:14-51`). It is the identical path with the one global key. The CLI quick start creates an identity and sends from it with the same key (CLI `README.md:90-103`).

### 2. CLI facts and copy-paste commands
**Package and install.** `@inkbox/cli` (bin `inkbox`, `package.json`), installed with `npm install -g @inkbox/cli` or `npx @inkbox/cli <cmd>`. Requires Node >= 22 (`inkbox-cli/SKILL.md:37-49`). It depends on `@inkbox/sdk ^0.7.19`.

**Auth precedence** is `--api-key` flag, then `INKBOX_API_KEY` env, then `~/.inkbox/config` line `api_key = ...` (CLI `dist/client.js:43-52`). Base URL comes from `--base-url`, `INKBOX_BASE_URL` or `base_url`. With no key the CLI exits 1 (`client.js:46-49`).

**Global flags** (`dist/index.js:43-47`): `--api-key`, `--vault-key`, `--base-url`, `--json`, `--with-response-metadata`. The CLI installs an env-proxy dispatcher when `HTTPS_PROXY` is set (`index.js:33-38`).

**Output.** With `--json`, results go to stdout via `console.log(JSON.stringify…)` (`dist/output.js:37-48`). Human output is a stdout record or table (`output.js:12-36`). Notes go to stderr. API errors under `--json` go to stderr as one JSON object (CLI `README.md:109-111`).

**Command availability:**
- **whoami** (`commands/whoami.js:5-13`) prints the whole whoami object, including `authSubtype` (admin vs agent claimed/unclaimed), `scope` and `organizationId`.
- **identity list / get / create**: `identity.js:263`, `:275` (output includes `id`, `mailbox`, `signingKeyConfigured`, `signingKeyCreatedAt` at `:302-303`), `:316`.
- **api-keys**: only `create` exists (`commands/api-keys.js:8-35`), with `--label` required, `--description`, and `--identity-id <uuid>`. It prints `{apiKey, record:{id,label,scopedIdentityId,status,createdAt}}` to stdout and the note "Store this key securely" to stderr (`:24-34`).
  - **There is no `api-keys list` or `revoke` in CLI 0.7.19, and the SDK `ApiKeysResource` has only `create`** (`api_keys/resources/apiKeys.js:13-37`). How to revoke is not documented beyond "Revoking the key revokes mail-client access" (`README.md:1407`). Deleting an identity "revokes any identity-scoped API keys" (`inkbox-cli/SKILL.md:148`).
- **Signing key**: `identity signing-key status <handle>` (`identity.js:211-220`). `identity signing-key rotate <handle>` (`identity.js:221-230`) prints `{signingKey, createdAt}` to stdout (JSON with `--json`), and "Store this key securely — it cannot be retrieved again." to stderr. The deprecated `signing-key create` is at `commands/signing-key.js:8-25`.
- **Webhook subscription create** (`commands/webhook.js:128-157`):
  - `--agent-identity-id <id>` (preferred; deprecated alternatives `--mailbox-id` and `--phone-number-id`), with exactly one selector
  - `--url <url>` (required, HTTPS)
  - `--event-type <type>` (repeatable, at least 1)
  - `--context-email|--context-texts|--context-calls count:N|window:H`
  - `--auth-token-stdin` (the bearer token is read only from stdin, `webhook.js:57-63`)
  - The one-time `signingKey` appears in the create output. Use `--json` to keep the SDK shape: "--json preserves the SDK response shape … so the one-time signingKey/ownerIdentityId survive" (`webhook.js:39-56`). It is `null` unless this create minted the identity's first key (SDK `webhooks/subscriptions.d.ts:66-76`).
- **Event types** (SDK `README.md:1537-1543`):
  - mail: `message.received|sent|forwarded|delivered|bounced|failed`
  - text: `text.received|sent|delivered|delivery_failed|delivery_unconfirmed`
  - iMessage: `imessage.received|reaction_received|sent|delivered|delivery_failed`
  - calls: `call.ended`
  - A2A: `a2a.task.created|a2a.task.message|a2a.task.canceled|a2a.sent_task.updated`
  - Mixed subscriptions need `supports_identity_subscriptions: true` from `GET /webhooks/catalog` and CLI 0.7.8 or later (`inkbox-cli/SKILL.md:791-799`).
- **Signature verification**: headers `x-inkbox-signature` (`sha256=` prefix), `x-inkbox-request-id`, `x-inkbox-timestamp`. HMAC-SHA256 over `"{requestId}.{timestamp}.{body}"`, with an optional `whsec_` prefix on the key (`dist/signing_keys.js:37-53`).

```bash
npm install -g @inkbox/cli            # Node >= 22
export INKBOX_API_KEY="ApiKey_..."    # or --api-key, or ~/.inkbox/config: api_key = ...
inkbox --json whoami                  # authSubtype, scope, organizationId
inkbox --json identity list
inkbox --json identity get <handle>   # gives id (uuid), mailbox, signingKeyConfigured
inkbox --json identity create <handle> --display-name "Name"      # admin/console; agents cannot create mailboxes
inkbox --json api-keys create --label <label> --identity-id <identity-uuid>   # caller must be admin-scoped or JWT
inkbox --json email send -i <handle> --to someone@example.com --subject "Hi" --body-text "Hello"   # REAL send: confirm first
inkbox --json email list -i <handle> --limit 10
inkbox --json email unread -i <handle> --limit 10
printf '%s' "$HOOK_TOKEN" | inkbox --json webhook subscription create \
  --agent-identity-id <identity-uuid> --url https://<host>/hook \
  --event-type message.received --event-type a2a.task.created --event-type a2a.task.message \
  --auth-token-stdin
inkbox --json webhook subscription list --agent-identity-id <identity-uuid> --scope identity
inkbox --json identity signing-key status <handle>     # read-only, safe
inkbox --json identity signing-key rotate <handle>     # DESTRUCTIVE for existing receivers (see 3)
inkbox webhook verify --payload '<raw body>' --secret '<whsec_...>' -H 'X-Inkbox-Signature: ...' -H 'X-Inkbox-Request-Id: ...' -H 'X-Inkbox-Timestamp: ...'
```

### 3. Does creating or rotating a signing key break existing verification?
**Rotating: yes, documented as a replace.**
- "Each agent identity has its own signing key used to verify the webhooks (and WebSocket upgrades) for that identity's mail / phone / iMessage traffic" (`dist/signing_keys.js:4-5`).
- "The first call mints a key; subsequent calls rotate (replace) it. The plaintext `signingKey` is returned **once**" (`signing_keys.js:69-72`).
- There is one key per identity, shared by all of that identity's subscriptions. No grace or overlap window is documented. Rotating an identity that already has a key therefore invalidates the secret every other receiver (the other agents) uses to verify that identity's webhooks, until they get the new secret. The skills flag it as high-risk (`inkbox-cli/SKILL.md:84`).

**Creating a new subscription does NOT rotate.** `signingKey` is "populated **only** on the request that first mints the owning identity's signing key … on every other create it is `null`" (`webhooks/subscriptions.d.ts:66-73`). A new receiver on an identity that already has a key gets no secret back.

**Options that avoid breakage:**
- (a) Reuse the existing secret from whoever holds it.
- (b) Use the per-subscription bearer token (`--auth-token-stdin`). Every delivery then carries `Authorization: Bearer <token>` alongside the signature headers (`inkbox-cli/SKILL.md:841`). It is independent per subscription, but it does not sign the body, and reads return the token (`get`/`--json` include `authToken`).
- (c) Use a new dedicated identity, whose first subscription mints its own key.

**Check first, read-only:** `identity signing-key status <handle>` or `identity get` (`signingKeyConfigured`).

### 4. Sender identity on `message.received`
**Payload shape.** `data.agent_identities: WebhookMailAgentIdentity[]`, each entry `{bucket, address, id, agent_handle, display_name}`, with `bucket: "from" | "to" | "cc" | "bcc"` (SDK `dist/webhooks/types.d.ts:156-157`, `:183-193`, `:255-260`).
- Inbound events resolve `from` plus every `cc`; outbound resolve to/cc/bcc (`inkbox-ts/SKILL.md:1430`).
- "Same matching rules as `contacts`. A peer can match both a contact and an agent identity — two rows are emitted; receivers decide precedence" (`types.d.ts:255-259`).
- Contacts are matched per address: "Pair to the source field by `(bucket, address)` … The list is sparse: only matched recipients appear" (`types.d.ts:158-169`).
- "`agent_identities` mirrors `contacts` but matches active agent identities in the same org" (SDK `README.md:1664-1666`).
- Up to 50 addresses are resolved; "over-cap inputs and resolver failures both fall back to an empty list" (`types.d.ts:248-252`).

**Is it authenticated?** The docs describe it only as **address matching against `from_address`**. No SPF/DKIM/DMARC or "verified sender" statement exists anywhere in the SDK, CLI or skills (searched). The only related field is `data.message.sender_access?: "direct" | "sponsored"`, documented as "Admission of this inbound message, **not sender trust or command permission**" (`dist/sender_access.d.ts:1-2`; field at `webhooks/types.d.ts:201-202`).

**Conclusion:** that resolution is authenticated is not documented. Treat `agent_identities` on mail as an address match that could be spoofed. Trust the webhook itself only after HMAC verification.

### 5. A2A
**Webhook events:** `"a2a.task.created" | "a2a.task.message" | "a2a.task.canceled" | "a2a.sent_task.updated"` (`webhooks/types.d.ts:633`).

**Payload `data`:** `{ sender?: A2AWebhookCaller|null, task_id, context_id, state, caller: A2AWebhookCaller, message_id?, parts? }`. `A2AWebhookCaller` is `{ identity_id, organization_id, handle: string|null, affiliation?: {domain, verifier, last_success_at, valid_until}|null }` (`types.d.ts:634-659`). The difference between `sender` and `caller` is not documented. REST task records add `caller.trustTier`, defaulted in the parser as `trust_tier ?? "inkbox_verified"` (`dist/a2a/types.js:12`).

**Sending by handle (SDK):**
1. `const client = await identity.a2aClient()`. This throws "A2A calls require this claimed identity's agent-scoped API key" unless whoami gives `authSubtype === "api_key.agent_scoped.claimed"` and `scope === agent_identity:${this.id}` (`agent_identity.js:1099-1107`). **An admin key cannot send A2A.**
2. `const target = await client.fetchCard(cardUrl)`.
3. `await client.send(target, {text, contextId?, taskId?, messageId?})`. This is JSON-RPC `SendMessage` (`dist/a2a/client.js:133-160`), with the key sent as `X-API-Key` only to the Inkbox platform origin (`client.js:82-84,109-114,246-248`).

**Getting the card URL by handle.** Client-side, it is not built from the handle. Read `cardUrl` from `identity.a2aSettings()` (`a2a/resource.js:20-21`) or from `inkbox.a2a.organizationDirectory({q})` items (`resource.js:70-77`). The README's `https://example.test/a2a/researcher/card` is a placeholder (SDK `README.md:1024-1029`).

**CLI:**
- `inkbox a2a call <card-url> -i <from-handle> --text "..." [--context <id>] [--task <id>] [--message-id <id>]` (CLI `commands/a2a.js:537-555`)
- `inkbox a2a settings -i <handle>` (`:202`)
- `inkbox a2a directory --query <q>` (`:229`)
- `inkbox a2a enable -i <handle>` (`:188`)
- `inkbox a2a tasks -i <handle>` (`:350`)
- `inkbox a2a reply <task-id> -i <handle> --complete|--ask|--progress|--fail --text "..."` (`:508-536`; REST `POST /identities/{handle}/a2a/tasks/{id}/reply` at `a2a/resource.js:179-187`)

**Admission:** "Same-organization and public discovery may imply admission. Private cross-organization calls require requester-outbound and worker-inbound permission; explicit blocks always win" (`inkbox-ts/SKILL.md:751-753`). Rules are added with `inkbox a2a rules add -i <h> --handle <peer> --action allow --direction outbound|inbound` (`inkbox-cli/SKILL.md:472-475`), which is admin-only.

**Is A2A stronger proof than email?** By construction, yes:
- The RPC is authenticated with the calling identity's own claimed agent-scoped key (`agent_identity.js:1100-1105`, `client.js:241-248`).
- Inkbox records the caller's `identity_id`, `organization_id` and `handle`.
- "Nested task participants are authoritative" (SDK `README.md:1016-1017`).
- By contrast, mail matching is address-based (section 4).
- The docs never use the words "caller is authenticated" for the webhook `caller` field.
- Domain affiliation "assertions do not establish legal identity or endorse an agent" (`inkbox-cli/SKILL.md:936-938`).

### 6. Documented limits
- **Email sends:**
  - Unclaimed: 5 recipient sends per fixed 24-hour window, only to `human_email`. Claimed: "Plan-based (100–5,000)" (`inkbox-agent-self-signup/SKILL.md:55-58`).
  - The effective limit is in `status.restrictions.max_sends_per_day` (`:115`; SDK `README.md:248`).
  - "Unclaimed agents have a limited send quota and can only email the `humanEmail`" (SDK `README.md:260`).
- **New-identity restrictions:**
  - Agents (claimed or unclaimed) cannot create mailboxes (`self-signup/SKILL.md:60`).
  - The verification code expires in 48 h, with max 5 attempts and a 5-minute resend cooldown (`:266,275`).
  - On the Free plan a footer is appended to stored bodies (`agent_identity.d.ts:186-187`).
  - Sends fail with 402 at the mailbox storage cap (`inkbox-cli/SKILL.md:276`).
- **SMS:**
  - 100 recipient sends per phone number per rolling 24 h; over the cap returns `429 sender_rate_limited` (`inkbox-cli/SKILL.md:360`).
  - New numbers need about 10-15 min of 10DLC propagation (`409 sender_sms_pending`) (`:361`).
  - Recipients must text START first (`:362`).
- **Mail import:** 20 jobs per org per 24 h (`inkbox-cli/SKILL.md:600-602`).
- **Not documented:**
  - identities per org
  - sends per minute
  - a "new identity" email warm-up or throttle beyond the claimed/unclaimed rules

### Open questions

- Server-side: does an admin-scoped key actually succeed on POST /api/v1/mail/mailboxes/{any-org-mailbox}/messages? Docs say 'full org-wide authority' (api_keys/types.d.ts:17-18) but never state it explicitly for sending. Verify with whoami plus one user-approved test send.
- Are the user's 3 existing identities in one org? Self-signup creates a provisional org per agent (inkbox-agent-self-signup/SKILL.md:161,255). Run `inkbox --json whoami` with each of the 3 keys and compare organizationId and authSubtype.
- Does the user have an admin-scoped key at all? An admin key can only be minted from the console (JWT). An admin key cannot mint another admin key (apiKeys.js:6-9).
- Signing-key rotation: is there any grace or overlap window? Not documented, so assume immediate replacement that breaks the other agents' verification.
- Is mail `data.agent_identities` resolution backed by sender authentication (SPF/DKIM, or internal Inkbox-to-Inkbox delivery)? Not documented. sender_access explicitly says 'not sender trust'.
- A2A webhook `data.sender` vs `data.caller`: the semantic difference is not documented.
- Can an admin key call a2aTasks/a2aReply for an identity (receiver side)? Not documented. Only outbound a2aClient is hard-gated to the claimed agent key.
- Same-org A2A admission is described as 'may imply admission'. Whether same-org calls need explicit rules is not definitive.
- API key list/revoke: absent from CLI and SDK 0.7.19. The revocation path (presumably the console) is not documented.
- The admin key's whoami `scope` value is not documented (agent keys use `agent_identity:<uuid>`).
- Identities-per-org and per-minute send limits are not documented anywhere.
