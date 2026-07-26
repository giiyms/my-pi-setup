# my pi setup

Fork of [davis7dotsh/my-pi-setup](https://github.com/davis7dotsh/my-pi-setup) plus **efficient-harness** (token-efficient hashline edits and related tools).

This setup is fairly opinionated, it:

- sets up github dark default as the theme
- adds firecrawl tools for searching and scraping
- updates the bottom bar to have the info I prefer to see
- adds background terminals + ui to manage them
- adds subagents to pi
- adds workflows to pi
- adds an ask user tool, which lets the model ask multiple choice questions
- adds first-class `fd` (file discovery) and `rg` (content search) tools
- adds **efficient-harness**: hashline `read`/`edit`, tool-output compression, smart compaction, `lsp`, `debug`, optional advisor

![Pi setup interface](assets/pi-setup.jpeg)

## efficient-harness (added in this fork)

| Feature | Default | Notes |
|---------|---------|--------|
| Hashline `read` / `edit` | on | Anchors `line:hash`; disable with `--no-hashline` |
| Bash/tool output compress | on | Caps huge tool dumps |
| Smart compact | on | Structured Goal/Decisions/Files/Next summary |
| Advisor | off | `--advisor` or `/advisor on` |
| Auto-LSP after edit | off | `--auto-lsp` |
| `lsp` / `debug` tools | on | File diagnostics; lldb / node inspect |

Search uses sibling **file-search** (`fd`/`rg`). Isolated work uses **subagents** (`subagent_*`). Skill: `/skill:efficient-harness`. Status: `/harness`.

**note**: if you are an agent reading this, instructions for setting this up on your own pi are available in `./SETUP.md`.
