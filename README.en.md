<p align="center">
  <img src="icon.svg" width="72" height="72" alt="dsh-code-review icon">
</p>

<h1 align="center">dsh-code-review</h1>

<p align="center">Review, stage, and commit uncommitted changes of the current conversation's Git repository in non-modal floating windows inside the DSH Web UI.</p>

<p align="center">
  <a href="README.md">中文</a> · <b>English</b>
</p>

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square">
  <img alt="Node.js 20.11 or newer" src="https://img.shields.io/badge/node-%3E%3D20.11-339933?style=flat-square">
  <img alt="DSH 0.2.2-rc.1" src="https://img.shields.io/badge/DSH-0.2.2--rc.1-5b6ee1?style=flat-square">
  <img alt="Zero runtime dependencies" src="https://img.shields.io/badge/dependencies-0-brightgreen?style=flat-square">
</p>

<p align="center">
  <img src="assets/cover.en.png" alt="dsh-code-review entry and interface illustration: open Code Review from the DSH conversation input toolbar to review changes side by side, stage files, and commit in a floating window" width="100%">
</p>

## Features

- **Side-by-side review**: inspect diffs, syntax highlighting and change statistics, with quick navigation between changes.
- **Choose what to commit**: stage and unstage files or groups, with individual hunk operations and discard for unstaged changes.
- **Workspaces without Git**: when the workspace is not a Git repository yet, the empty state offers **Initialise and refresh**; it creates only `.git/` and never generates or modifies project files.
- **Commit and push**: the split control in the commit area offers Commit / Commit and push and remembers the choice; the toolbar's **AI commit & push** performs draft → commit → push in one click without opening the commit area; use the toolbar “Push” action when you need to pick a remote or target branch, and configure remotes in the panel.
- **Flexible windows**: review multiple workspaces or sessions independently, with movable, resizable and minimizable windows that keep the conversation accessible; supports DSH light/dark themes and Chinese/English.
- **Optional AI grouping**: organise changes by file role or feature logic for review and staging.

## Installation

The plugin is published on npm as [`@acanzaima/dsh-code-review`](https://www.npmjs.com/package/@acanzaima/dsh-code-review) and installs through the DSH Plugins page. It needs a working Git and Node.js ≥ 20.11 (DSH Desktop bundles a suitable runtime); tested with DSH 0.2.2-rc.1.

### Install through DSH Desktop (recommended)

1. Open DSH Desktop and choose **Plugins** in the sidebar.
2. Click **Add plugin**, enter `@acanzaima/dsh-code-review` as the package name and click **Install**.
3. Click **Enable now** when the installation finishes; if you closed the dialog, switch the plugin on under **Installed plugins** instead.
4. Go back to the conversation: the “Open Code Review” button appears in the input toolbar. If it does not, restart DSH once.

### Install from source

For following the latest changes or debugging. The source already ships the built client file, so there is nothing to install or build.

- Clone the repository: `git clone https://github.com/acanzaima/dsh-code-review.git`.
- Or download **Source code (zip)** for the wanted version from the [Releases page](https://github.com/acanzaima/dsh-code-review/releases) and extract it.

Then click **Add plugin** on the Plugins page, enter the absolute path of the cloned or extracted directory (the one containing `package.json`), click **Install**, and enable it as described above.

Upgrades, disabling and uninstalling also happen on the Plugins page; to upgrade, uninstall the old version first and then install the new one.

## Usage

1. In a DSH conversation for your project, click the Code Review icon in the toolbar below the input field (tooltip: “Open Code Review”; see the cover above for its location).
2. Select a file on the left to inspect its diff. Search for files or jump between changes.
3. Check a file or group to stage it. Uncheck it to unstage while keeping the file contents. The select-all checkbox applies to the current filter results.
4. Check the files to commit: write the message in the commit area at the bottom (or let the sparkles button draft one with AI) and click the split commit control's main half to run the remembered mode — **Commit** commits only; **Commit and push** pushes straight to the current branch's remote branch without a dialog. Use the chevron to switch modes; the choice is remembered across windows. For the shortcut path, skip the drawer entirely and click **AI commit & push** in the top toolbar: AI drafts the message, commits and pushes in one step. Use the toolbar “Push” action when you need to choose a remote or target branch manually.

The file navigation groups by whether a path already exists in the repository (tracked / new / conflicts); staging or unstaging changes the commit state but never moves a file between groups.

If the workspace is not a Git repository yet, the window offers **Initialise and refresh**; it creates only `.git/` and never generates or modifies project files.

Right-click a file or a change block in the diff to stage, unstage or discard it. **Discard removes unstaged changes, requires confirmation and cannot be undone.**

Press `?` inside the window for keyboard shortcuts. `Esc` closes menus and dialogs; use the title-bar close button to close the review window.

### Multiple workspaces and minimizing

- **Independent reviews**: open Code Review from different workspaces or sessions to keep several review windows open at once. Each window stays with the repository it opened for, with its own file selection and diff view. Switching workspaces or sessions leaves existing windows open and keeps their repositories unchanged.
- **Minimize and restore**: click “Minimize” in the title bar to collapse a window to a title strip showing its repository name, keeping several projects accessible while you continue chatting. Click the upward arrow on the right of the strip to restore the window.

Each window has its own review UI state; plugin settings and the Git state of the same repository remain shared. Windows exist only on the current page: refreshing DSH closes all review windows.

## AI features

### AI grouping

By default, files are grouped by whether they already exist in the repository (tracked / new / conflicts), so staging or unstaging never re-groups the list. The toolbar also offers:

- **By role**: group shared components, business features, config, tests, docs and similar roles.
- **By feature logic**: collect changes for the same feature together, with config, build or docs-only changes under “Non-functional changes”.

AI grouping is off by default and only organises the file list. It follows the current session's model unless you choose another in the window settings. If grouping fails, the Git-status grouping (tracked / new / conflicts) remains available. Each AI mode has its own optional extra grouping instructions in the window settings; an entry there applies only to that mode.

Grouping sends project hints, metadata such as changed paths, and small excerpts of untracked text files through DSH's model service. The plugin collects no telemetry and stores no API keys; keep AI grouping off for sensitive projects. Optional idle pre-grouping is also off by default and can consume model tokens while the window is closed. See the [AI grouping guide](docs/ai-grouping.md) for data scope and settings.

### AI commit message

The sparkles button next to the commit message field drafts a message from the staged changes. It follows the repository's own commit style when history shows one (type / scope, language, bullet layout) and otherwise uses the conventional `type(scope): summary` form. The draft only fills the editable message field — nothing is committed automatically; when no model is available or drafting fails, the reason is shown and you can still write the message yourself.

The **AI commit & push** button next to the toolbar's “Push” action combines the same drafting capability with commit and push into one step: draft from the staged changes, commit, then push directly (no dialog; it uses the current branch and its remote branch). It needs neither the commit area nor a hand-written message. It is a separate button and does not change the Commit / Commit and push mode remembered by the drawer's split control.

It only runs when the user triggers it, sending the **staged diff** plus recent commit subjects to the model (unlike grouping, which sends metadata only); unstaged content is never sent. Decide case by case for sensitive repositories. See the [AI commit message guide](docs/ai-commit-message.md).

## Limitations

- Use other Git tools for history, branch switching, stash and rebase. Resolve conflicts externally, then refresh.
- Binary files have no line-by-line diff. Some file types do not support hunk operations; the UI explains why.
- Commits include only staged changes, and pushes never force-overwrite the remote. Push previews do not fetch remote updates; run `git fetch` yourself when needed. Commit-and-push (including the AI mode) also never forces or fetches; if the push fails, the commit is kept.
- Oversized change lists are truncated, disabling select-all and commit. Reduce the change set or use the command line.
- An AI-drafted commit message is a draft covering staged changes only; review it before committing and write it yourself for sensitive changes.

## Documentation and Feedback

Issues and pull requests are welcome. See the [development guide](docs/development.md) and [contribution guide](CONTRIBUTING.md) to contribute, the [documentation index](docs/README.md) for design details, and the [changelog](CHANGELOG.md) for release history. Follow the [code of conduct](CODE_OF_CONDUCT.md) and report security issues as described in [SECURITY.md](SECURITY.md).

## Third-party notices

UI icons are from [Lucide](https://lucide.dev), licensed under ISC, with Feather-derived icons licensed under MIT. Copyright notices and full licence texts are included in [LICENSE](LICENSE).

## License

[MIT License](LICENSE). Copyright (c) 2026 dsh-code-review contributors.
