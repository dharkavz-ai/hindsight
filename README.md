# Hindsight

**Your own past notes cross-examine what you're about to do.**

Tell Hindsight a plan or belief ("I'm going to quit and go freelance"). It finds the
passages in *your own journal* that contradict it or repeat an old pattern, shows them as
numbered exhibits, and a local LLM plays "Past You": it cites those exhibits and ends with
one hard question.

Everything runs on-device through the [QVAC SDK](https://github.com/tetherto/qvac):
no API key, no server in the cloud, no usage bill. Your journal never leaves your machine,
which is the whole point of a journal.

Use it two ways: in the **terminal**, or in your **browser** at `http://localhost:3000`.

## Demo

```
I am going to… › quit my job and go freelance next month

EXHIBITS FROM YOUR OWN NOTES
Exhibit A  2023-03-14.md · relevance 0.82
  Quit the agency today to go freelance. Feeling unstoppable...
Exhibit B  2025-02-11.md · relevance 0.72
  ...I was afraid of the empty calendar, not the work.
Exhibit C  2025-02-11.md · relevance 0.62
  If I ever try again, I need clients lined up before I quit, not after.

PAST YOU TAKES THE STAND
Exhibit A shows you were ready to quit, but Exhibit B reveals you were afraid of the
empty calendar. Your current statement conflicts with that fear... What will you do
when the calendar is empty?
```

## How it works

| Step | QVAC function |
|------|---------------|
| Load the embedding model and the language model | `loadModel` |
| Embed and index your note passages | `ragIngest` |
| Retrieve the passages most relevant to your claim | `ragSearch` |
| Stream Past You's cross-examination | `completion` |
| Clean up | `ragCloseWorkspace`, `unloadModel` |

Models: `GTE_LARGE_FP16` (embeddings, ~670 MB) and `QWEN3_1_7B_INST_Q4` (generation).
They download automatically the first time you run the app.

## Requirements

- Node.js 22.17 or newer, npm 10.9 or newer
- A few GB of free RAM and about 2 GB of disk for the models
- **QVAC SDK version used: `@qvac/sdk` 0.20.0**

## Install

```bash
git clone https://github.com/dharkavz-ai/hindsight.git
cd hindsight
npm install
```

## Run in the terminal

Windows (Command Prompt):

```cmd
set QVAC_CONFIG_PATH=./qvac.config.json
npm start
```

macOS / Linux:

```bash
QVAC_CONFIG_PATH=./qvac.config.json npm start
```

One-shot mode (ask a single question and exit):

```bash
node hindsight.js "I'm going to quit my job and go freelance next month"
```

## Run in the browser

Windows (Command Prompt):

```cmd
set QVAC_CONFIG_PATH=./qvac.config.json
npm run web
```

macOS / Linux:

```bash
QVAC_CONFIG_PATH=./qvac.config.json npm run web
```

Wait for `Hindsight is ready`, then open **http://localhost:3000** in your browser.

This is not a public website. The server runs on your own computer and listens on
`127.0.0.1` only, so the page opens only on the machine where you started it, and only
while it is running. Press `Ctrl+C` in the terminal to stop it. To use another port, set
`PORT` (for example `set PORT=4000`).

## Use your own notes

Put `.md` or `.txt` files in a folder and point Hindsight at it:

```bash
HINDSIGHT_NOTES=./notes-private npm start
```

On Windows Command Prompt: `set HINDSIGHT_NOTES=./notes-private` then `npm start`
(or `npm run web`).

The `notes/` folder ships with fictional sample entries so the demo works immediately.
`notes-private/` is git-ignored so your real journal is never committed.

## Project layout

| File | What it does |
|------|--------------|
| `hindsight.js` | Terminal app |
| `server.js` | Local web server (Node's built-in `http`, no extra dependencies) |
| `public/index.html` | Browser page that streams the answer |
| `notes/` | Sample journal entries |

## Notes

- Hindsight is instructed to use only what is in your notes. If nothing conflicts with your
  plan, it should say so rather than invent something.
- The first answer after startup can take a few seconds on CPU-only machines.

## License

MIT