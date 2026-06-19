const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
require('dotenv').config();

const ENV_PATH = path.join(__dirname, '.env');

const app = express();
// Large limit — recorded/uploaded audio arrives as base64 in the JSON body.
app.use(express.json({ limit: '300mb' }));
app.use(express.static(path.join(__dirname)));

const jobs = new Map(); // jobId -> { emitter, status, error, transcription }

// ─── Known config keys (used by the settings panel) ──────────────────────────
const CONFIG_KEYS = ['RAPIDAPI_KEY', 'IVRIT_API_KEY', 'IVRIT_ENDPOINT_ID', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];

// ═══════════════════════════════════════════════════════════════════════════
//  Config (read / save API keys)
// ═══════════════════════════════════════════════════════════════════════════

// Report which keys are configured (never returns the secret values themselves).
app.get('/api/config', (req, res) => {
  const status = {};
  for (const key of CONFIG_KEYS) {
    const val = (process.env[key] || '').trim();
    status[key] = { configured: !!val, hint: val ? maskKey(val) : '' };
  }
  res.json({ status });
});

// Save keys — writes to .env and updates the live process.
app.post('/api/config', (req, res) => {
  const updates = req.body || {};
  const toWrite = {};
  for (const key of CONFIG_KEYS) {
    if (typeof updates[key] === 'string' && updates[key].trim()) {
      toWrite[key] = updates[key].trim();
      process.env[key] = toWrite[key];
    }
  }
  try {
    updateEnvFile(toWrite);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function maskKey(val) {
  if (val.length <= 8) return '••••';
  return val.slice(0, 4) + '••••' + val.slice(-4);
}

function updateEnvFile(updates) {
  let lines = [];
  if (fs.existsSync(ENV_PATH)) {
    lines = fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/);
  }
  const seen = new Set();
  const out = lines.map(line => {
    const m = line.match(/^([A-Z0-9_]+)\s*=/);
    if (m && updates.hasOwnProperty(m[1])) {
      seen.add(m[1]);
      return `${m[1]}=${updates[m[1]]}`;
    }
    return line;
  });
  for (const [key, val] of Object.entries(updates)) {
    if (!seen.has(key)) out.push(`${key}=${val}`);
  }
  fs.writeFileSync(ENV_PATH, out.join('\n'), 'utf8');
}

// ═══════════════════════════════════════════════════════════════════════════
//  YouTube → audio link (download only, no transcription)
// ═══════════════════════════════════════════════════════════════════════════

app.post('/api/youtube/resolve', async (req, res) => {
  const { youtubeUrl } = req.body || {};
  if (!youtubeUrl) return res.status(400).json({ error: 'חסר קישור' });
  if (!process.env.RAPIDAPI_KEY) return res.status(400).json({ error: 'חסר מפתח RapidAPI — הגדר אותו בהגדרות' });

  const videoId = extractYouTubeId(youtubeUrl);
  if (!videoId) return res.status(400).json({ error: 'קישור YouTube לא תקין' });

  try {
    let result = null;
    for (let attempt = 0; attempt < 15; attempt++) {
      const { data } = await axios.get('https://youtube-mp36.p.rapidapi.com/dl', {
        params: { id: videoId },
        headers: {
          'x-rapidapi-host': 'youtube-mp36.p.rapidapi.com',
          'x-rapidapi-key': process.env.RAPIDAPI_KEY,
        },
      });
      if (data.status === 'ok') { result = data; break; }
      if (data.status === 'processing') { await sleep(4000); continue; }
      return res.status(500).json({ error: data.msg || `סטטוס לא צפוי: ${data.status}` });
    }
    if (!result) return res.status(500).json({ error: 'זמן ההמתנה להמרה חלף' });
    res.json({ ok: true, videoId, mp3Url: result.link, title: result.title, duration: result.duration });
  } catch (err) {
    res.status(500).json({ error: err.message, status: err.response?.status });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  Transcription pipeline
// ═══════════════════════════════════════════════════════════════════════════

// Start a transcription job. Accepts one of:
//   { source:'link',   youtubeUrl }
//   { source:'upload', audioBase64, filename }
//   { source:'record', audioBase64 }
app.post('/api/transcribe', (req, res) => {
  const { source, youtubeUrl, audioBase64, filename } = req.body || {};

  if (source === 'link' && !youtubeUrl) return res.status(400).json({ error: 'חסר קישור' });
  if ((source === 'upload' || source === 'record') && !audioBase64) {
    return res.status(400).json({ error: 'חסר קובץ אודיו' });
  }

  const jobId = Date.now().toString();
  const emitter = new EventEmitter();
  jobs.set(jobId, { emitter, status: 'running' });
  res.json({ jobId });

  runTranscription(jobId, { source, youtubeUrl, audioBase64, filename }).catch(err => {
    const job = jobs.get(jobId);
    if (job) {
      job.status = 'error';
      job.error = err.message;
      job.emitter.emit('error', err.message);
    }
  });

  // Drop finished jobs after a while to avoid leaking memory.
  setTimeout(() => jobs.delete(jobId), 30 * 60 * 1000);
});

// SSE progress stream
app.get('/api/progress/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const onStatus = (d) => send(d);
  const onDone = (transcription) => { send({ type: 'done', transcription }); res.end(); };
  const onError = (msg) => { send({ type: 'error', message: msg }); res.end(); };

  job.emitter.on('status', onStatus);
  job.emitter.on('done', onDone);
  job.emitter.on('error', onError);

  req.on('close', () => {
    job.emitter.off('status', onStatus);
    job.emitter.off('done', onDone);
    job.emitter.off('error', onError);
  });
});

async function runTranscription(jobId, { source, youtubeUrl, audioBase64 }) {
  const job = jobs.get(jobId);
  const status = (phase, message) => job.emitter.emit('status', { type: 'status', phase, message });

  let blob = audioBase64;

  // ── Link source: download audio from YouTube via RapidAPI ────────────────
  if (source === 'link') {
    if (!process.env.RAPIDAPI_KEY) throw new Error('חסר מפתח RapidAPI — הגדר אותו בהגדרות');

    const videoId = extractYouTubeId(youtubeUrl);
    if (!videoId) throw new Error('לא ניתן לחלץ מזהה וידאו מהקישור');

    status('download', 'מאתר את האודיו ביוטיוב...');
    let mp3Url = null;
    for (let attempt = 0; attempt < 15; attempt++) {
      const { data } = await axios.get('https://youtube-mp36.p.rapidapi.com/dl', {
        params: { id: videoId },
        headers: {
          'x-rapidapi-host': 'youtube-mp36.p.rapidapi.com',
          'x-rapidapi-key': process.env.RAPIDAPI_KEY,
        },
      });
      if (data.status === 'ok') { mp3Url = data.link; break; }
      if (data.status === 'processing') {
        status('download', `ממיר לאודיו... (${attempt + 1}/15)`);
        await sleep(4000);
        continue;
      }
      throw new Error(data.msg || `סטטוס לא צפוי: ${data.status}`);
    }
    if (!mp3Url) throw new Error('זמן ההמתנה להמרה חלף');

    status('download', 'מוריד את קובץ האודיו...');
    const audioResp = await axios.get(mp3Url, { responseType: 'arraybuffer', timeout: 120000 });
    blob = Buffer.from(audioResp.data).toString('base64');
  }

  // ── Transcribe with ivrit.ai on RunPod serverless ────────────────────────
  if (!process.env.IVRIT_API_KEY || !process.env.IVRIT_ENDPOINT_ID) {
    throw new Error('חסרים פרטי ivrit.ai (API key / Endpoint ID) — הגדר אותם בהגדרות');
  }

  status('transcribe', 'שולח לתמלול בעברית (ivrit.ai)... זה עשוי לקחת מספר דקות');

  const endpointId = process.env.IVRIT_ENDPOINT_ID;
  const transcribeResp = await axios.post(
    `https://api.runpod.ai/v2/${endpointId}/runsync`,
    {
      input: {
        engine: 'faster-whisper',
        model: 'ivrit-ai/whisper-large-v3-turbo-ct2',
        transcribe_args: { blob },
      },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.IVRIT_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 600000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    }
  );

  const transcription = extractTranscription(transcribeResp.data);
  if (!transcription) throw new Error('לא התקבל טקסט מהתמלול');

  job.status = 'done';
  job.transcription = transcription;
  job.emitter.emit('done', transcription);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractTranscription(responseData) {
  try {
    const allBatches = responseData?.output?.[0]?.result;
    if (Array.isArray(allBatches)) {
      const texts = [];
      for (const batch of allBatches) {
        if (!Array.isArray(batch)) continue;
        for (const event of batch) {
          if (event.type === 'segments' && Array.isArray(event.data)) {
            for (const seg of event.data) {
              if (seg.text) texts.push(seg.text.trim());
            }
          }
        }
      }
      if (texts.length > 0) return texts.join(' ').trim();
    }
    const out = responseData?.output;
    return out?.transcription || out?.text ||
      (Array.isArray(out?.segments) ? out.segments.map((s) => s.text).join(' ') : null) ||
      null;
  } catch {
    return null;
  }
}

function extractYouTubeId(url) {
  const match = url.match(
    /(?:youtube\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?/\s]{11})/
  );
  return match ? match[1] : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Torah Transcribe → http://localhost:${PORT}`));
