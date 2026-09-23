#!/usr/bin/env node
// Hindsight: your own past notes cross-examine what you're about to do.
// 100% on-device: embeddings, retrieval and generation all run through QVAC.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import {
  loadModel,
  unloadModel,
  completion,
  ragIngest,
  ragSearch,
  ragCloseWorkspace,
  GTE_LARGE_FP16,
  QWEN3_1_7B_INST_Q4
} from '@qvac/sdk';

const NOTES_DIR = process.env.HINDSIGHT_NOTES || './notes';
const WORKSPACE = 'hindsight-notes';
const TOP_K = 4;
const MAX_CHUNK_CHARS = 900;

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`
};

// Shows model download progress on first run only.
function onProgress(label) {
  return (p) => {
    const mb = (n) => (n / 1e6).toFixed(1);
    const line = `▸ Downloading ${label} ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`;
    process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
    if (p.percentage >= 100) process.stderr.write('\n');
  };
}

// One chunk per paragraph, prefixed with its file name so the source
// travels with the text through embedding and retrieval.
function readNotes(dir) {
  if (!fs.existsSync(dir)) return [];
  const chunks = [];
  for (const file of fs.readdirSync(dir).sort()) {
    if (!/\.(md|txt)$/i.test(file)) continue;
    const raw = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const para of raw.split(/\n\s*\n/)) {
      const text = para.replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim();
      if (text.length < 30) continue;
      chunks.push(`[${file}] ${text.slice(0, MAX_CHUNK_CHARS)}`);
    }
  }
  return chunks;
}

function parseExhibit(content) {
  const m = content.match(/^\[(.+?)\]\s*([\s\S]*)$/);
  return m ? { source: m[1], text: m[2] } : { source: 'unknown', text: content };
}

async function crossExamine({ llmId, embedId, claim }) {
  const hits = await ragSearch({
    modelId: embedId,
    workspace: WORKSPACE,
    query: claim,
    topK: TOP_K
  });

  if (!hits.length) {
    console.log(c.yellow('\nNo relevant notes found. Nothing to cross-examine you with.\n'));
    return;
  }

  const exhibits = hits.map((h, i) => ({
    letter: String.fromCharCode(65 + i),
    score: h.score,
    ...parseExhibit(h.content)
  }));

  console.log(`\n${c.bold('EXHIBITS FROM YOUR OWN NOTES')}`);
  for (const e of exhibits) {
    console.log(`${c.red(`Exhibit ${e.letter}`)} ${c.dim(`${e.source} · relevance ${Number(e.score).toFixed(2)}`)}`);
    console.log(`  ${e.text.length > 220 ? e.text.slice(0, 220) + '…' : e.text}`);
  }

  const evidence = exhibits
    .map((e) => `Exhibit ${e.letter} (${e.source}): ${e.text}`)
    .join('\n\n');

  const history = [
    {
      role: 'system',
      content:
        'You are the user\'s own past self, speaking from their private journal. ' +
        'Speak in first person to your present self. Be direct, honest and caring. ' +
        'Only use the journal excerpts you are given.'
    },
    {
      role: 'user',
      content:
        `Here are excerpts from my journal:\n\n${evidence}\n\n` +
        `Today I am saying: "${claim}"\n\n` +
        'Reply as my past self in under 100 words. Point out where these excerpts ' +
        'conflict with, or repeat a pattern in, what I am saying today, and cite them ' +
        'as Exhibit A, Exhibit B, etc. If they do not conflict, say so honestly. ' +
        'End with one hard question. /no_think'
    }
  ];

  console.log(`\n${c.bold('PAST YOU TAKES THE STAND')}\n`);
  const run = completion({
    modelId: llmId,
    history,
    stream: true,
    captureThinking: true,
    generationParams: { temp: 0.4, predict: 900 }
  });

  for await (const event of run.events) {
    if (event.type === 'contentDelta') process.stdout.write(event.text);
  }
  const final = await run.final;
  const tps = final.stats?.tokensPerSecond;
  console.log(c.dim(`\n\n(${tps ? tps.toFixed(1) + ' tok/s · ' : ''}generated locally, nothing left this machine)\n`));
}

async function main() {
  const chunks = readNotes(NOTES_DIR);
  if (!chunks.length) {
    console.error(`No .md/.txt notes found in "${NOTES_DIR}". Add some, or set HINDSIGHT_NOTES=/path/to/notes`);
    process.exit(1);
  }

  console.log(c.bold('\nHINDSIGHT') + c.dim(': your past notes vs. your present plans'));
  console.log(c.dim(`${chunks.length} note passages from "${NOTES_DIR}"\n`));

  let embedId;
  let llmId;
  try {
    embedId = await loadModel({ modelSrc: GTE_LARGE_FP16, onProgress: onProgress('embedding model') });
    llmId = await loadModel({
      modelSrc: QWEN3_1_7B_INST_Q4,
      modelConfig: { ctx_size: 4096 },
      onProgress: onProgress('language model')
    });

    // Start from a clean workspace so re-runs never duplicate passages.
    try { await ragCloseWorkspace({ workspace: WORKSPACE, deleteOnClose: true }); } catch { /* none yet */ }

    process.stdout.write('▸ Reading your notes on-device… ');
    const result = await ragIngest({ modelId: embedId, workspace: WORKSPACE, documents: chunks, chunk: false });
    console.log(`indexed ${result.processed.length} passages.`);

    const argClaim = process.argv.slice(2).join(' ').trim();
    if (argClaim) {
      await crossExamine({ llmId, embedId, claim: argClaim });
    } else {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      console.log(c.dim('\nTell Past You what you\'re about to do or believe. Empty line to quit.\n'));
      while (true) {
        const claim = (await rl.question(c.bold('I am going to… › '))).trim();
        if (!claim) break;
        await crossExamine({ llmId, embedId, claim });
      }
      rl.close();
    }
  } catch (error) {
    console.error('✖', error);
    process.exitCode = 1;
  } finally {
    try { await ragCloseWorkspace({ workspace: WORKSPACE, deleteOnClose: true }); } catch { /* ignore */ }
    if (llmId) await unloadModel({ modelId: llmId, clearStorage: false }).catch(() => {});
    if (embedId) await unloadModel({ modelId: embedId, clearStorage: false }).catch(() => {});
    process.exit(process.exitCode ?? 0);
  }
}

main();