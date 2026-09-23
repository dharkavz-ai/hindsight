#!/usr/bin/env node
// Hindsight web: the same on-device cross-examination, in your browser.
// The server binds to 127.0.0.1 only, so it is reachable from this computer alone.
// Embeddings, retrieval and generation all run locally through QVAC.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NOTES_DIR = process.env.HINDSIGHT_NOTES || './notes';
const PORT = Number(process.env.PORT) || 3000;
const WORKSPACE = 'hindsight-web';
const TOP_K = 4;
const MAX_CHUNK_CHARS = 900;
const MAX_CLAIM_CHARS = 500;

function onProgress(label) {
  return (p) => {
    const mb = (n) => (n / 1e6).toFixed(1);
    const line = `▸ Downloading ${label} ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`;
    process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
    if (p.percentage >= 100) process.stderr.write('\n');
  };
}

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

let embedId;
let llmId;
let passageCount = 0;
let busy = false; // one cross-examination at a time keeps the local model happy

function send(res, obj) {
  res.write(JSON.stringify(obj) + '\n');
}

function readBody(req, limit = 10_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function handleAsk(req, res) {
  let claim = '';
  try {
    claim = String(JSON.parse(await readBody(req)).claim || '').trim().slice(0, MAX_CLAIM_CHARS);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad request' }));
    return;
  }
  if (!claim) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Type what you are about to do first.' }));
    return;
  }
  if (busy) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Past You is still answering. Try again in a moment.' }));
    return;
  }

  busy = true;
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
  try {
    const hits = await ragSearch({ modelId: embedId, workspace: WORKSPACE, query: claim, topK: TOP_K });
    const exhibits = hits.map((h, i) => ({
      letter: String.fromCharCode(65 + i),
      score: Number(h.score),
      ...parseExhibit(h.content)
    }));
    send(res, { type: 'exhibits', exhibits });

    if (!exhibits.length) {
      send(res, { type: 'done' });
      return;
    }

    const evidence = exhibits.map((e) => `Exhibit ${e.letter} (${e.source}): ${e.text}`).join('\n\n');
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
          'Make your final sentence one hard question for me. /no_think'
      }
    ];

    const run = completion({
      modelId: llmId,
      history,
      stream: true,
      captureThinking: true,
      generationParams: { temp: 0.4, predict: 900 }
    });

    for await (const event of run.events) {
      if (event.type === 'contentDelta') send(res, { type: 'token', text: event.text });
    }
    const final = await run.final;
    send(res, { type: 'done', tokensPerSecond: final.stats?.tokensPerSecond ?? null });
  } catch (error) {
    console.error('✖', error);
    send(res, { type: 'error', message: 'Something went wrong while generating. Check the terminal.' });
  } finally {
    busy = false;
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } else if (req.method === 'GET' && url.pathname === '/api/info') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ passages: passageCount, notesDir: NOTES_DIR }));
    } else if (req.method === 'POST' && url.pathname === '/api/ask') {
      await handleAsk(req, res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  } catch (error) {
    console.error('✖', error);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

async function shutdown() {
  console.log('\n▸ Shutting down…');
  server.close();
  try { await ragCloseWorkspace({ workspace: WORKSPACE, deleteOnClose: true }); } catch { /* ignore */ }
  if (llmId) await unloadModel({ modelId: llmId, clearStorage: false }).catch(() => {});
  if (embedId) await unloadModel({ modelId: embedId, clearStorage: false }).catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function main() {
  const chunks = readNotes(NOTES_DIR);
  if (!chunks.length) {
    console.error(`No .md/.txt notes found in "${NOTES_DIR}". Add some, or set HINDSIGHT_NOTES=/path/to/notes`);
    process.exit(1);
  }
  passageCount = chunks.length;

  try {
    embedId = await loadModel({ modelSrc: GTE_LARGE_FP16, onProgress: onProgress('embedding model') });
    llmId = await loadModel({
      modelSrc: QWEN3_1_7B_INST_Q4,
      modelConfig: { ctx_size: 4096 },
      onProgress: onProgress('language model')
    });
    try { await ragCloseWorkspace({ workspace: WORKSPACE, deleteOnClose: true }); } catch { /* none yet */ }
    const result = await ragIngest({ modelId: embedId, workspace: WORKSPACE, documents: chunks, chunk: false });
    console.log(`▸ Indexed ${result.processed.length} passages on-device.`);
  } catch (error) {
    console.error('✖', error);
    process.exit(1);
  }

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\n▸ Hindsight is ready: http://localhost:${PORT}`);
    console.log('▸ Only this computer can open it. Press Ctrl+C to stop.\n');
  });
}

main();