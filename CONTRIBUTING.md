# Contributing to visually-3d

Thanks for your interest! Contributions of all kinds are welcome — new sample
scenes, bug fixes, features, and docs.

By participating, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **🤖 Add a sample scene** — the easiest and most valuable contribution.
- **🐛 Fix a bug** or **✨ add a feature** — open an issue first for anything non-trivial.
- **📝 Improve docs** — typos and clarifications are always welcome.

## Add a sample scene (the one-command path)

```bash
visually create "<your machine>"     # generate from a prompt
visually improve <id>                # recursively refine it (visual feedback)
visually check <id> --png            # eyeball the render
visually upload <id>                 # forks + opens a PR for you (needs `gh`)
```

`upload` uses your own GitHub login (`gh auth login`), adds the scene under
`public/samples/`, registers it in `public/samples/index.json`, and opens the
PR. No manual git needed.

### …or by hand

1. Drop a valid [`MachineSceneDescriptor`](docs/schema.json) JSON in `public/samples/<id>.json`.
2. Add an entry to `public/samples/index.json` (`id`, `title`, `subtitle`, `path`, `accent`, `category`).
3. `node bin/visually.js check <id> --png` to confirm it renders.
4. Open a PR.

**Scene quality bar:** parts should be recognizable and legible from an
isometric view (the "X-ray test" — if a part is buried inside a solid box, the
render hides it, so the scene hides it). Run a couple of `improve` passes before
submitting.

## Develop from source

```bash
git clone https://github.com/NyxFoundation/visually-3d.git
cd visually-3d
npm install            # or: bun install
npm run build          # required before `serve`
node bin/visually.js serve
```

`create`, `improve`, and `check --png` don't need a build — only the browser
GUI does. See the [README](README.md#develop-from-source) for the full dev loop.

## Pull request guidelines

- Keep PRs focused — one logical change per PR.
- Match the surrounding code style (no linter is enforced; just be consistent).
- Run `npm run build` if you touched the frontend or anything that ships in `dist/`.
- Never commit API keys, tokens, or personal data. This tool intentionally
  handles **no** credentials — keep it that way.
- Fill out the PR template checklist.

## Reporting bugs & requesting features

Use the [issue templates](https://github.com/NyxFoundation/visually-3d/issues/new/choose).
For security issues, see [SECURITY.md](SECURITY.md) — please don't open a public issue.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
