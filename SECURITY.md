# Security Policy

`dsh-code-review` is a local DSH (DeepSeek Harness) Web UI plugin that reviews, stages and commits
the uncommitted changes of the current conversation's repository. It has no hosted service, no
server of its own and no runtime dependencies.

## Supported versions

| Version | DSH version | Supported |
| --- | --- | --- |
| 0.1.x | 0.2.2-rc.1 | Yes |
| older | any | No |

Only the latest 0.1.x release receives security fixes. The plugin is currently developed and
validated against DSH `0.2.2-rc.1`; other DSH versions are untested. Fixes ship as patch releases and
are documented in [CHANGELOG.md](CHANGELOG.md).

## Reporting a vulnerability

Report security issues privately: open the repository's **Security** tab, choose **Report a
vulnerability** (GitHub private security advisory), and do not open a public issue for an unpatched
vulnerability. Include enough detail to reproduce and assess the issue:

- plugin version and DSH version, plus operating system and Node.js version;
- a minimal reproduction: commands, workspace shape and the panel action involved;
- impact and preconditions (what an attacker must control or be able to do);
- any suggested fix or mitigation.

Reports are handled on a best-effort basis, with no guaranteed response time or SLA. We will
acknowledge reports, coordinate disclosure and give credit unless you ask otherwise.

## Threat model and guarantees

- Runs as a Cordis host plugin inside the local DSH process with the DSH user's privileges; all Git
  operations act on the repository resolved from the current conversation's working directory.
- Registers one HTTP route, `POST /api/code-review`, through DSH's connection layer. DSH
  authenticates the browser session and forwards only owner peers; the plugin handles no tokens or
  cookies and performs no authentication of its own.
- Invokes Git exclusively through argv arrays, never a shell, so paths, branch names and commit
  messages cannot be interpreted as shell syntax.
- Persists settings in the DSH home directory (`~/.dsh/code-review/settings.json` by default) with
  atomic temp-file plus rename writes; stores no API keys, credentials or tokens.
- Sends no telemetry and makes no network requests except through DSH's `llm` service when optional
  AI grouping is enabled.

### AI grouping data sharing

AI grouping is disabled by default and runs only when the user enables it and requests a
classification. It sends bounded change metadata: repository name, up to 40 top-level directory
names, up to 12 manifest file names, and per-entry status, change type, path, rename source and
line counts. For at most 20 newly added text files it sends an excerpt of at most 2 KiB / 24 lines
(about 1200 characters). It never sends whole files, the repository or Git history. Credential-like
paths (`.env*`, `.npmrc`, `.netrc`, `.pypirc`, `.git-credentials`, private keys, `*.pem`, `*.key`,
`*.p12`, `*.pfx`, `*.keystore`, `*.jks`, and paths containing `secret`, `credential` or `token`)
are never excerpted. Requests go through the DSH `llm` service with the user's configured model;
the plugin stores no model credentials. See [docs/ai-grouping.md](docs/ai-grouping.md).

### Destructive operations

- **Discard** restores unstaged working-tree changes after explicit confirmation; it cannot be undone.
- **Push** never uses force; a rejected push is reported to the user.
- **Commit** only commits content already in the index, after re-reading Git state and validating
  fingerprints; it never stages content implicitly.

## Out of scope

- DSH core, its authentication and its plugin platform: report to the DSH project.
- The model provider used for AI grouping and its data handling: governed by that provider.
- OS-level Git configuration, hooks, credential helpers and remote authentication.
- Repository contents, including secrets committed to them.

## Safe-use guidance

- Point the plugin only at trusted workspaces; discard can permanently lose uncommitted work.
- DSH is a local development tool. If you expose its Web UI on a network interface, make sure the
  connection is authenticated and trusted; the plugin relies on DSH session authentication.
- Review the diff before discarding, committing or pushing, especially after another tool has
  modified the working tree.
- Enable AI grouping only for code you are comfortable sending to the configured model provider;
  leave it off for confidential code.
