const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = require('docx');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const jobs = new Map(); // jobId -> { emitter, status, filename, error, results }
let lastDebug = null; // stores last RunPod raw response for /api/debug

// ─── Start pipeline, return jobId ────────────────────────────────────────────
app.post('/api/process', (req, res) => {
  const { youtubeUrl } = req.body;
  if (!youtubeUrl) return res.status(400).json({ error: 'Missing YouTube URL' });

  const jobId = Date.now().toString();
  const emitter = new EventEmitter();
  jobs.set(jobId, { emitter, status: 'running', results: {} });

  res.json({ jobId });

  runPipeline(jobId, youtubeUrl).catch(err => {
    const job = jobs.get(jobId);
    if (job) {
      job.status = 'error';
      job.error = err.message;
      job.emitter.emit('error', err.message);
    }
  });
});

// ─── Resume from a specific step ─────────────────────────────────────────────
app.post('/api/resume', (req, res) => {
  const { fromStep, youtubeUrl, transcription, parts, rewrittenText } = req.body;
  if (!fromStep) return res.status(400).json({ error: 'Missing fromStep' });

  const jobId = Date.now().toString();
  const emitter = new EventEmitter();
  jobs.set(jobId, { emitter, status: 'running', results: {} });

  res.json({ jobId });

  runFromStep(jobId, { fromStep, youtubeUrl, transcription, parts, rewrittenText }).catch(err => {
    const job = jobs.get(jobId);
    if (job) {
      job.status = 'error';
      job.error = err.message;
      job.emitter.emit('error', err.message);
    }
  });
});

// ─── SSE: stream progress to client ──────────────────────────────────────────
app.get('/api/progress/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const onStep = (data) => send(data);
  const onDone = (filename) => { send({ type: 'done', filename }); res.end(); };
  const onError = (msg) => { send({ type: 'error', message: msg }); res.end(); };

  job.emitter.on('step', onStep);
  job.emitter.on('done', onDone);
  job.emitter.on('error', onError);

  req.on('close', () => {
    job.emitter.off('step', onStep);
    job.emitter.off('done', onDone);
    job.emitter.off('error', onError);
  });
});

// ─── Debug: last RunPod response ──────────────────────────────────────────────
app.get('/api/debug', (req, res) => res.json(lastDebug || { msg: 'no data yet' }));

// ─── Test Step 1: YouTube URL → MP3 download URL ─────────────────────────────
app.post('/api/test/step1', async (req, res) => {
  const { youtubeUrl } = req.body;
  if (!youtubeUrl) return res.status(400).json({ error: 'Missing youtubeUrl' });

  const videoId = extractYouTubeId(youtubeUrl);
  if (!videoId) return res.status(400).json({ error: 'לא ניתן לחלץ video ID' });

  try {
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
      if (data.status === 'processing') { await sleep(4000); continue; }
      return res.status(500).json({ error: data.msg || `status: ${data.status}` });
    }
    if (!mp3Url) return res.status(500).json({ error: 'timeout — לא הצליח להמיר' });
    res.json({ ok: true, videoId, mp3Url });
  } catch (err) {
    res.status(500).json({ error: err.message, status: err.response?.status });
  }
});

// ─── Test Step 2: MP3 URL → RunPod ivrit.ai ──────────────────────────────────
app.post('/api/test/step2', async (req, res) => {
  const { mp3Url } = req.body;
  if (!mp3Url) return res.status(400).json({ error: 'Missing mp3Url' });

  const endpointId = process.env.IVRIT_ENDPOINT_ID;
  if (!endpointId) return res.status(500).json({ error: 'חסר IVRIT_ENDPOINT_ID ב-.env' });

  try {
    const audioResp = await axios.get(mp3Url, { responseType: 'arraybuffer', timeout: 120000 });
    const audioBlob = Buffer.from(audioResp.data).toString('base64');

    const transcribeResp = await axios.post(
      `https://api.runpod.ai/v2/${endpointId}/runsync`,
      {
        input: {
          engine: 'faster-whisper',
          model: 'ivrit-ai/whisper-large-v3-turbo-ct2',
          transcribe_args: { blob: audioBlob },
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

    const raw = transcribeResp.data;
    const transcription = extractTranscription(raw);
    res.json({ ok: !!transcription, transcription, raw });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      status: err.response?.status,
      body: err.response?.data,
    });
  }
});

// ─── Test Step 3: transcription → Claude split + proofread per part ──────────
app.post('/api/test/step3', async (req, res) => {
  const { transcription } = req.body;
  if (!transcription) return res.status(400).json({ error: 'Missing transcription' });
  try {
    // 3a: split
    const splitResp = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: 'claude-sonnet-4-6', max_tokens: 8192,
        messages: [{ role: 'user', content: buildClaudeSplitPrompt(transcription) }] },
      { headers: { 'anthropic-version': '2023-06-01', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'content-type': 'application/json' }, timeout: 180000 }
    );
    const rawParts = parseClaudeParts(splitResp.data.content[0].text);
    if (!rawParts || rawParts.length === 0) return res.status(500).json({ error: 'לא התקבלו חלקים מ-Claude' });

    // 3b: proofread each part
    const proofreadParts = [];
    for (const part of rawParts) {
      const proofResp = await axios.post(
        'https://api.anthropic.com/v1/messages',
        { model: 'claude-sonnet-4-6', max_tokens: 8192,
          messages: [{ role: 'user', content: buildClaudeProofreadPrompt(part) }] },
        { headers: { 'anthropic-version': '2023-06-01', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'content-type': 'application/json' }, timeout: 180000 }
      );
      proofreadParts.push(proofResp.data.content[0].text.trim());
    }
    res.json({ ok: true, parts: proofreadParts, rawParts, count: proofreadParts.length });
  } catch (err) {
    res.status(500).json({ error: err.message, status: err.response?.status });
  }
});

// ─── Test Step 4: parts[] → GPT rewrite each → combined ──────────────────────
app.post('/api/test/step4', async (req, res) => {
  const { parts } = req.body;
  if (!Array.isArray(parts) || parts.length === 0) return res.status(400).json({ error: 'Missing parts array' });
  try {
    const rewritten = [];
    for (const part of parts) {
      const gptResp = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        { model: 'gpt-4o',
          messages: [
            { role: 'system', content: 'אתה עורך לשוני של שיעורי תורה בעברית.' },
            { role: 'user', content: 'בבקשה תשכתב את החלק הזה יותר טוב, תשמור על זרימה ורציפות.\nתוסיף כותרות משנה בלי קווים תחתיים.\nשמור על כל התוכן והרעיונות המקוריים ללא קיצורים.\nשמור על כל הציטוטים מהתנ"ך והמדרש בדיוק כפי שהם.\nאל תוסיף סימני markdown כמו ** או ##.\nהחזר את הטקסט המשוכתב בלבד ללא הקדמות.\n\n' + part }
          ],
          max_tokens: 4096 },
        { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 120000 }
      );
      rewritten.push(gptResp.data.choices[0].message.content);
    }
    res.json({ ok: true, combined: rewritten.join('\n\n'), parts: rewritten });
  } catch (err) {
    res.status(500).json({ error: err.message, status: err.response?.status });
  }
});

// ─── Test Step 5: combined text → Word document ───────────────────────────────
app.post('/api/test/step5', async (req, res) => {
  const { text, title } = req.body;
  if (!text) return res.status(400).json({ error: 'Missing text' });

  try {
    if (!fs.existsSync(path.join(__dirname, 'output'))) fs.mkdirSync(path.join(__dirname, 'output'));
    const filename = `torah_test_${Date.now()}.docx`;
    const outputPath = path.join(__dirname, 'output', filename);
    await buildDocx(text, title || 'שיעור תורה', outputPath);
    res.json({ ok: true, filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Download generated Word file ─────────────────────────────────────────────
app.get('/api/download/:filename', (req, res) => {
  const filepath = path.join(__dirname, 'output', req.params.filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });
  res.download(filepath);
});

// ─── Full Pipeline ────────────────────────────────────────────────────────────

async function runPipeline(jobId, youtubeUrl) {
  const job = jobs.get(jobId);
  const emit = (step, status, message) =>
    job.emitter.emit('step', { type: 'step', step, status, message });
  const emitResult = (step, data) => {
    job.results[`step${step}`] = data;
    job.emitter.emit('step', { type: 'result', step, data });
  };

  if (!fs.existsSync(path.join(__dirname, 'output'))) {
    fs.mkdirSync(path.join(__dirname, 'output'));
  }

  // ── Step 1: Download audio via RapidAPI ─────────────────────────────────
  emit(1, 'active', 'מוריד אודיו מיוטיוב...');

  const videoId = extractYouTubeId(youtubeUrl);
  if (!videoId) throw new Error('לא ניתן לחלץ מזהה וידאו מהכתובת');

  let mp3Url;
  try {
    for (let attempt = 0; attempt < 15; attempt++) {
      const { data } = await axios.get('https://youtube-mp36.p.rapidapi.com/dl', {
        params: { id: videoId },
        headers: {
          'x-rapidapi-host': 'youtube-mp36.p.rapidapi.com',
          'x-rapidapi-key': process.env.RAPIDAPI_KEY,
        },
      });

      if (data.status === 'ok') {
        mp3Url = data.link;
        break;
      } else if (data.status === 'processing') {
        emit(1, 'active', `ממיר לאודיו... (${attempt + 1}/15)`);
        await sleep(4000);
      } else {
        throw new Error(data.msg || `סטטוס לא צפוי: ${data.status}`);
      }
    }
    if (!mp3Url) throw new Error('זמן ההמתנה להמרה חלף');
  } catch (err) {
    emit(1, 'error', `שגיאה בהורדת האודיו: ${err.message}`);
    throw err;
  }

  emit(1, 'active', 'מוריד קובץ MP3...');
  let audioBlob;
  try {
    const audioResp = await axios.get(mp3Url, { responseType: 'arraybuffer', timeout: 120000 });
    audioBlob = Buffer.from(audioResp.data).toString('base64');
    emit(1, 'done', 'האודיו הורד בהצלחה');
    emitResult(1, { mp3Url, videoId });
  } catch (err) {
    emit(1, 'error', `שגיאה בהורדת MP3: ${err.message}`);
    throw err;
  }

  // ── Step 2: Transcribe with ivrit.ai via RunPod serverless ──────────────
  emit(2, 'active', 'שולח לתמלול עברית ב-ivrit.ai...');

  let transcription;
  try {
    const endpointId = process.env.IVRIT_ENDPOINT_ID;
    if (!endpointId) throw new Error('חסר IVRIT_ENDPOINT_ID ב-.env');

    const transcribeResp = await axios.post(
      `https://api.runpod.ai/v2/${endpointId}/runsync`,
      {
        input: {
          engine: 'faster-whisper',
          model: 'ivrit-ai/whisper-large-v3-turbo-ct2',
          transcribe_args: { blob: audioBlob },
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

    lastDebug = { raw: JSON.stringify(transcribeResp.data).slice(0, 2000) };
    transcription = extractTranscription(transcribeResp.data);
    if (!transcription) throw new Error('לא התקבל טקסט מה-transcription');

    emit(2, 'done', 'התמלול הושלם בהצלחה');
    emitResult(2, { transcription });
  } catch (err) {
    const detail = err.response
      ? `status=${err.response.status} body=${JSON.stringify(err.response.data).slice(0, 500)}`
      : err.message;
    lastDebug = Object.assign(lastDebug || {}, { error: detail, stack: err.stack });
    emit(2, 'error', `שגיאה בתמלול: ${detail}`);
    throw err;
  }

  // ── Step 3a: Split transcription into logical parts with Claude ─────────
  emit(3, 'active', 'מחלק לחלקים לוגיים עם Claude...');

  let rawParts;
  try {
    const splitResp = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 8192,
        messages: [{ role: 'user', content: buildClaudeSplitPrompt(transcription) }],
      },
      {
        headers: {
          'anthropic-version': '2023-06-01',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'content-type': 'application/json',
        },
        timeout: 180000,
      }
    );
    rawParts = parseClaudeParts(splitResp.data.content[0].text);
    if (!rawParts || rawParts.length === 0) throw new Error('Claude לא החזיר חלקים תקינים');
    emit(3, 'active', `החלוקה הושלמה — ${rawParts.length} חלקים. מגיה...`);
  } catch (err) {
    emit(3, 'error', `שגיאה בחלוקה: ${err.message}`);
    throw err;
  }

  // ── Step 3b: Proofread each part separately with Claude ─────────────────
  let parts;
  try {
    const proofreadParts = [];
    for (let i = 0; i < rawParts.length; i++) {
      emit(3, 'active', `מגיה חלק ${i + 1}/${rawParts.length}...`);
      const proofResp = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-sonnet-4-6',
          max_tokens: 8192,
          messages: [{ role: 'user', content: buildClaudeProofreadPrompt(rawParts[i]) }],
        },
        {
          headers: {
            'anthropic-version': '2023-06-01',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'content-type': 'application/json',
          },
          timeout: 180000,
        }
      );
      proofreadParts.push(proofResp.data.content[0].text.trim());
    }
    parts = proofreadParts;
    emit(3, 'done', `ההגהה הושלמה — ${parts.length} חלקים`);
    emitResult(3, { parts, rawParts, original: transcription });
  } catch (err) {
    emit(3, 'error', `שגיאה בהגהה: ${err.message}`);
    throw err;
  }

  // ── Step 4: Rewrite each part with GPT, then combine ─────────────────────
  const rewrittenParts = [];
  for (let i = 0; i < parts.length; i++) {
    emit(4, 'active', `משכתב חלק ${i + 1}/${parts.length} עם GPT...`);
    try {
      const gptResp = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: 'אתה עורך לשוני של שיעורי תורה בעברית.' },
            { role: 'user', content: 'בבקשה תשכתב את החלק הזה יותר טוב, תשמור על זרימה ורציפות.\nתוסיף כותרות משנה בלי קווים תחתיים.\nשמור על כל התוכן והרעיונות המקוריים ללא קיצורים.\nשמור על כל הציטוטים מהתנ"ך והמדרש בדיוק כפי שהם.\nאל תוסיף סימני markdown כמו ** או ##.\nהחזר את הטקסט המשוכתב בלבד ללא הקדמות.\n\n' + parts[i] },
          ],
          max_tokens: 4096,
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 120000,
        }
      );
      rewrittenParts.push(gptResp.data.choices[0].message.content);
    } catch (err) {
      emit(4, 'error', `שגיאה בשכתוב חלק ${i + 1}: ${err.message}`);
      throw err;
    }
  }

  const combined = rewrittenParts.join('\n\n');
  emit(4, 'done', `השכתוב הושלם — ${parts.length} חלקים שולבו`);
  emitResult(4, { combined, parts: rewrittenParts });

  // ── Step 5: Create Word document ──────────────────────────────────────────
  emit(5, 'active', 'יוצר קובץ Word...');

  let filename;
  try {
    const timestamp = new Date().toLocaleDateString('he-IL').replace(/\//g, '-');
    filename = `torah_lesson_${jobId}.docx`;
    const outputPath = path.join(__dirname, 'output', filename);

    await buildDocx(combined, `שיעור תורה — ${timestamp}`, outputPath, youtubeUrl);

    emit(5, 'done', 'קובץ Word נוצר בהצלחה');
    emitResult(5, { filename });
    job.status = 'done';
    job.filename = filename;
    job.emitter.emit('done', filename);
  } catch (err) {
    emit(5, 'error', `שגיאה ביצירת Word: ${err.message}`);
    throw err;
  }
}

// ─── Resume from a specific step ─────────────────────────────────────────────

async function runFromStep(jobId, { fromStep, youtubeUrl, transcription, parts, rewrittenText }) {
  const job = jobs.get(jobId);
  const emit = (step, status, message) =>
    job.emitter.emit('step', { type: 'step', step, status, message });
  const emitResult = (step, data) => {
    job.results[`step${step}`] = data;
    job.emitter.emit('step', { type: 'result', step, data });
  };

  if (!fs.existsSync(path.join(__dirname, 'output'))) {
    fs.mkdirSync(path.join(__dirname, 'output'));
  }

  // Mark skipped steps as done
  for (let s = 1; s < fromStep; s++) {
    emit(s, 'done', 'דולג (המשך מאמצע)');
  }

  let currentParts = parts || [];
  let currentTranscription = transcription || '';
  let currentCombined = rewrittenText || '';

  if (fromStep <= 3) {
    // Step 3a: Claude splits transcription into logical parts
    emit(3, 'active', 'מחלק לחלקים לוגיים עם Claude...');
    let rawParts;
    try {
      const splitResp = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-sonnet-4-6',
          max_tokens: 8192,
          messages: [{ role: 'user', content: buildClaudeSplitPrompt(currentTranscription) }],
        },
        {
          headers: {
            'anthropic-version': '2023-06-01',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'content-type': 'application/json',
          },
          timeout: 180000,
        }
      );
      rawParts = parseClaudeParts(splitResp.data.content[0].text);
      if (!rawParts || rawParts.length === 0) throw new Error('Claude לא החזיר חלקים תקינים');
      emit(3, 'active', `החלוקה הושלמה — ${rawParts.length} חלקים. מגיה...`);
    } catch (err) {
      emit(3, 'error', `שגיאה בחלוקה: ${err.message}`);
      throw err;
    }

    // Step 3b: Proofread each part separately
    try {
      const proofreadParts = [];
      for (let i = 0; i < rawParts.length; i++) {
        emit(3, 'active', `מגיה חלק ${i + 1}/${rawParts.length}...`);
        const proofResp = await axios.post(
          'https://api.anthropic.com/v1/messages',
          {
            model: 'claude-sonnet-4-6',
            max_tokens: 8192,
            messages: [{ role: 'user', content: buildClaudeProofreadPrompt(rawParts[i]) }],
          },
          {
            headers: {
              'anthropic-version': '2023-06-01',
              'x-api-key': process.env.ANTHROPIC_API_KEY,
              'content-type': 'application/json',
            },
            timeout: 180000,
          }
        );
        proofreadParts.push(proofResp.data.content[0].text.trim());
      }
      currentParts = proofreadParts;
      emit(3, 'done', `ההגהה הושלמה — ${currentParts.length} חלקים`);
      emitResult(3, { parts: currentParts, rawParts, original: currentTranscription });
    } catch (err) {
      emit(3, 'error', `שגיאה בהגהה: ${err.message}`);
      throw err;
    }
  }

  if (fromStep <= 4) {
    // Step 4: GPT rewrites each part
    const rewrittenParts = [];
    for (let i = 0; i < currentParts.length; i++) {
      emit(4, 'active', `משכתב חלק ${i + 1}/${currentParts.length} עם GPT...`);
      try {
        const gptResp = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model: 'gpt-4o',
            messages: [
              { role: 'system', content: 'אתה עורך לשוני של שיעורי תורה בעברית.' },
              { role: 'user', content: 'בבקשה תשכתב את החלק הזה יותר טוב, תשמור על זרימה ורציפות.\nתוסיף כותרות משנה בלי קווים תחתיים.\nשמור על כל התוכן והרעיונות המקוריים ללא קיצורים.\nשמור על כל הציטוטים מהתנ"ך והמדרש בדיוק כפי שהם.\nאל תוסיף סימני markdown כמו ** או ##.\nהחזר את הטקסט המשוכתב בלבד ללא הקדמות.\n\n' + currentParts[i] },
            ],
            max_tokens: 4096,
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
              'Content-Type': 'application/json',
            },
            timeout: 120000,
          }
        );
        rewrittenParts.push(gptResp.data.choices[0].message.content);
      } catch (err) {
        emit(4, 'error', `שגיאה בשכתוב חלק ${i + 1}: ${err.message}`);
        throw err;
      }
    }
    currentCombined = rewrittenParts.join('\n\n');
    emit(4, 'done', `השכתוב הושלם — ${currentParts.length} חלקים שולבו`);
    emitResult(4, { combined: currentCombined, parts: rewrittenParts });
  }

  // Step 5: Create Word document (always runs)
  emit(5, 'active', 'יוצר קובץ Word...');
  try {
    const timestamp = new Date().toLocaleDateString('he-IL').replace(/\//g, '-');
    const filename = `torah_lesson_${jobId}.docx`;
    const outputPath = path.join(__dirname, 'output', filename);

    await buildDocx(currentCombined, `שיעור תורה — ${timestamp}`, outputPath, youtubeUrl);

    emit(5, 'done', 'קובץ Word נוצר בהצלחה');
    emitResult(5, { filename });
    job.status = 'done';
    job.filename = filename;
    job.emitter.emit('done', filename);
  } catch (err) {
    emit(5, 'error', `שגיאה ביצירת Word: ${err.message}`);
    throw err;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function buildDocx(text, title, outputPath, sourceUrl) {
  const children = [
    new Paragraph({
      children: [new TextRun({ text: title, bold: true, size: 36, font: 'David' })],
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.RIGHT,
    }),
  ];

  if (sourceUrl) {
    children.push(new Paragraph({
      children: [new TextRun({ text: `מקור: ${sourceUrl}`, size: 18, color: '888888', font: 'David' })],
      alignment: AlignmentType.RIGHT,
      spacing: { after: 400 },
    }));
  }

  for (const block of text.split(/\n\n+/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('# ') || trimmed.startsWith('## ')) {
      children.push(new Paragraph({
        children: [new TextRun({ text: trimmed.replace(/^#+\s*/, ''), bold: true, size: 28, font: 'David' })],
        alignment: AlignmentType.RIGHT,
        spacing: { before: 300, after: 150 },
      }));
    } else {
      const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);
      const runs = [];
      lines.forEach((line, i) => {
        const cleaned = line.replace(/\*\*(.*?)\*\*/g, '$1');
        const isBold = /^\*\*.*\*\*$/.test(line);
        runs.push(new TextRun({ text: cleaned, bold: isBold, size: 24, font: 'David' }));
        if (i < lines.length - 1) runs.push(new TextRun({ break: 1 }));
      });
      children.push(new Paragraph({
        children: runs,
        alignment: AlignmentType.RIGHT,
        spacing: { after: 200 },
      }));
    }
  }

  const doc = new Document({ sections: [{ properties: {}, children }] });
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
}

function buildClaudeSplitPrompt(transcription) {
  return (
    'אתה עוזר שמחלק שיעורי תורה לחלקים לוגיים.\n' +
    'קיבלת תמלול של שיעור תורה.\n' +
    'תפקידך: לחלק את הטקסט ל-2 עד 5 חלקים לפי נושאים, אם יש יותר מנושא אחד.\n' +
    'אם כל השיעור הוא נושא אחד, החזר חלק אחד בלבד.\n' +
    'אל תערוך את הטקסט, אל תגיה — רק חלק.\n' +
    'החזר JSON בלבד ללא טקסט נוסף: {"parts": ["...", "...", ...]}\n\n' +
    'התמלול:\n\n' +
    transcription
  );
}

function buildClaudeProofreadPrompt(part) {
  return (
    'אתה עורך לשוני של שיעורי תורה בעברית.\n' +
    'קיבלת חלק מתמלול שיעור.\n' +
    'בצע הגהה לשונית מדויקת:\n' +
    '- תקן שגיאות כתיב ותמלול\n' +
    '- פשט משפטים מסורבלים\n' +
    '- שמור על כל התוכן והרעיונות ללא קיצורים\n' +
    '- שמור על כל הציטוטים מהתנ"ך והמדרש בדיוק\n' +
    '- אל תוסיף כותרות\n' +
    '- אל תוסיף תוכן חדש\n' +
    'החזר את הטקסט המוגה בלבד ללא הקדמות.\n\n' +
    'החלק:\n\n' +
    part
  );
}

function parseClaudeParts(rawText) {
  const match = rawText.match(/\{[\s\S]*"parts"\s*:\s*\[[\s\S]*\]\s*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (Array.isArray(parsed.parts) && parsed.parts.length > 0) return parsed.parts;
  } catch {}
  return null;
}

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
app.listen(PORT, () => console.log(`Torah Pipeline → http://localhost:${PORT}`));
