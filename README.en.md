<div align="center">

# Claude Code Chinese Translation

[简体中文](README.md) · **English**

Use Chinese in the native `claude` CLI. Your Chinese reaches Claude only as English, and replies turn into Chinese right where they appear.

<img src="docs/demo.svg" width="860" alt="Illustration: your Chinese stays in your row with the English that was sent underneath; replies are shown in Chinese in place, code is kept as-is, and the status line shows the translation model and cost">

</div>

## Features

- **English only to Claude.** A translation model turns your Chinese into English, and only the English is sent. Your row still shows what you typed, and the line starting with ↳ underneath shows exactly what was sent.
- **Chinese replies.** Claude replies in English. Each block is translated in the background as soon as it's finished, then shown in Chinese in place. You can also keep the English with the Chinese below it.
- **Untouched content.** Code blocks, tables, paths and commands are kept as-is.
- **English stays English.** English messages go through unchanged, and their replies aren't translated.
- **Menus for settings.** `/zh` opens a settings menu and `/zh-model` picks the translation model. Changes apply immediately.
- **Consistent wording.** A glossary keeps terms consistent, and reply translations reuse the wording of your own message.
- **Visible cost.** You can see each translation's cost and the session total, optionally in your status line.

## How it works

<img src="docs/how-it-works.en.svg" width="860" alt="How it works: your Chinese goes through a translation model and Claude receives only English; each finished reply block goes through the translation model and is shown in Chinese in place">

It's a Claude Code plugin installed in `~/.claude/skills/zh-translate`, which Claude Code loads automatically at startup.

## Requirements

- **Claude Code 2.1.287 or newer.** Check with `claude --version`, upgrade with `claude update`. The plugin uses Claude Code's new plugin API, which older versions can't load.
- **Node.js 18 or newer.** Check with `node --version`.
- **A logged-in Claude Code.** Translations run on your own account and count toward your usage or plan limits.

## Install

1. Download: click **Code → Download ZIP** on this page, or `git clone` the repository, and unzip it anywhere.
2. Run the installer:
   - Windows: double-click `install.cmd`, or run `node install.mjs` in a terminal in that folder.
   - macOS / Linux: run `node install.mjs` in that folder.
3. Restart `claude`. If it's already open, you can type `/reload-plugins` instead.

Running the installer again is safe and is how you upgrade. Your mode, scope, model and glossary are kept.

If you used the earlier version (the one built on hooks in settings.json), the installer backs up your settings first, then removes the old hooks and the old `/zh` and `/zh-model` commands.

## Usage

Just ask in Chinese. Use `/zh` for settings:

<img src="docs/menu.svg" width="620" alt="Illustration: the /zh settings menu, with on/off, how replies are shown, which replies are translated, and the translation model">

| Command | What it does |
|---|---|
| `/zh` | Opens the settings menu: on/off, how replies are shown, which replies are translated, translation model. Move with the arrow keys or Tab, press Enter to choose, Esc to close |
| `/zh on` / `/zh off` | Turn translation on / off |
| `/zh only` | Show replies in Chinese only (default) |
| `/zh both` | Show the English reply with the Chinese and its cost below |
| `/zh all` | Translate every reply (default) |
| `/zh final` | Translate only the last reply of each turn; Claude's working messages stay in English. Your messages are still translated |
| `/zh-model` | Opens a list to pick the translation model; Enter to confirm, Esc to cancel |
| `/zh model <model ID>` | Switch models without the menu, e.g. `/zh model claude-haiku-4-5` |

Notes:

- **Changes apply at once.** For example, switching from `only` to `both` redraws the replies already on screen.
- **No cost for commands.** The plugin handles these commands itself; they're never sent to Claude.
- **Translations in progress.** A reply still being translated shows in English with a "翻译中…" (translating) note, then switches to Chinese.

### Glossary

`~/.claude/zh-translate/glossary.txt` holds one `中文 = English` pair per line, used in both directions. To keep a term in Chinese, write it as `term = term`. Edits apply from the next translation.

### Status line (optional)

If you use [ccstatusline](https://github.com/sirmalloc/ccstatusline), add a "custom command" widget to show something like `译: Sonnet 5.5 $0.012`: the current translation model and this session's translation cost. The installer prints the exact command at the end; it looks like this:

```
"<path to node>" "<home>/.claude/zh-translate/status.mjs"
```

## Speed and cost

Costs are estimated from the tokens each translation uses, at each model's API price. On a subscription plan, translations use your plan's limits instead.

| Model | Speed | Translation |
|---|---|---|
| Haiku 4.5 | Fastest, about 2 s per block | Literal; occasionally mistranslates jargon |
| Sonnet 5.5 (default) | Fast, about 3 s per block | Natural |
| Opus | Slower | Natural |
| Fable | Slowest and most expensive | Natural |

The `/zh-model` list shows an estimated price per reply block for each version. Translating a typical reply costs $0.002–0.02, far less than Claude's reply itself.

## Limitations

- **The conversation is saved in English.** Both your messages and Claude's replies are stored in English; the Chinese is only how they're displayed. The plugin keeps a copy of the session's translations, so a resumed session still shows Chinese where it can.
- **Some things stay in English:** tool calls, Claude's thinking, and permission prompts.
- **`claude -p` (scripted runs) has no screen.** `/zh` and `/zh-model` reply with text only, and with the `all` scope, the last reply's translation may not finish before the program exits.

## Uninstall

On Windows, double-click `uninstall.cmd`; elsewhere, run `node uninstall.mjs`. It removes:

- the plugin;
- its settings and glossary;
- its temporary files;
- anything left by the earlier version.

If you added the status line widget, remove it yourself.

## Implementation notes

- **Before sending:** a `prompt.submit` hook replaces your message with its English translation before it reaches Claude.
- **Your row:** a `UserMessage` render hook draws it in Chinese.
- **Replies:** each reply block is translated in the background when it's stored (`session.append`), and an `AssistantMessage` render hook draws it in Chinese.
- **Display only:** the Chinese exists only on screen; the saved conversation stays in English.
- **Privacy:** translation uses your own Claude login (`$.model.complete`), never a third-party service.
- **Tests:** the plugin ships with tests; run them with `claude plugin test ~/.claude/skills/zh-translate`.

The images in this README are illustrations based on the plugin's real output.
