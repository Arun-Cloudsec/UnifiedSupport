require('dotenv').config({ quiet: true });
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Database ----------
// Railway auto-provides DATABASE_URL when a PostgreSQL plugin is attached to this service.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS submissions (
      id SERIAL PRIMARY KEY,
      product_name TEXT,
      customer TEXT,
      product_owner TEXT,
      sdm TEXT,
      go_live TEXT,
      meta JSONB NOT NULL DEFAULT '{}',
      resp JSONB NOT NULL DEFAULT '{}',
      addl JSONB NOT NULL DEFAULT '{}',
      completion_pct INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

function computePct(resp, fw) {
  const all = Object.keys(fw).flatMap(k => fw[k].items);
  if (!all.length) return 0;
  const done = all.filter(i => {
    const r = resp[i.id] || {};
    return r.status === 'Confirmed' || r.status === 'Not Applicable';
  }).length;
  return Math.round((done / all.length) * 100);
}

// Framework definition duplicated server-side (kept in sync with public/app-data.js)
// so completion % can be computed without trusting the client.
const FW = require('./fw-data.json');

// ---------- API: submissions (backend storage) ----------

// List all submissions (summary view)
app.get('/api/submissions', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, product_name, customer, product_owner, sdm, go_live, completion_pct, created_at, updated_at
       FROM submissions ORDER BY updated_at DESC LIMIT 200`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list submissions' });
  }
});

// Fetch one full submission
app.get('/api/submissions/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM submissions WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch submission' });
  }
});

// Create or update (upsert) a submission — used for "Save" and autosave
app.post('/api/submissions', async (req, res) => {
  try {
    const { id, meta = {}, resp = {}, addl = {} } = req.body;
    const pct = computePct(resp, FW);
    if (id) {
      const { rows } = await pool.query(
        `UPDATE submissions SET product_name=$1, customer=$2, product_owner=$3, sdm=$4, go_live=$5,
           meta=$6, resp=$7, addl=$8, completion_pct=$9, updated_at=now()
         WHERE id=$10 RETURNING id`,
        [meta.pn || '', meta.cu || '', meta.po || '', meta.sdm || '', meta.gl || '',
         meta, resp, addl, pct, id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      return res.json({ id: rows[0].id, completion_pct: pct });
    } else {
      const { rows } = await pool.query(
        `INSERT INTO submissions (product_name, customer, product_owner, sdm, go_live, meta, resp, addl, completion_pct)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [meta.pn || '', meta.cu || '', meta.po || '', meta.sdm || '', meta.gl || '',
         meta, resp, addl, pct]
      );
      return res.json({ id: rows[0].id, completion_pct: pct });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save submission' });
  }
});

// Delete a submission
app.delete('/api/submissions/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM submissions WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete submission' });
  }
});

// ---------- Email ----------
function buildTransport() {
  if (!process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
}

const MAIL_TO = process.env.MAIL_TO || 'arun.vivek@gmail.com';

// Save the submission AND email the generated report in one call.
// The frontend sends the same reportHtml it renders on-screen, so the email matches exactly.
app.post('/api/generate-report', async (req, res) => {
  try {
    const { id, meta = {}, resp = {}, addl = {}, reportHtml } = req.body;
    const pct = computePct(resp, FW);

    // 1. Persist to the database (upsert)
    let submissionId = id;
    if (submissionId) {
      await pool.query(
        `UPDATE submissions SET product_name=$1, customer=$2, product_owner=$3, sdm=$4, go_live=$5,
           meta=$6, resp=$7, addl=$8, completion_pct=$9, updated_at=now() WHERE id=$10`,
        [meta.pn || '', meta.cu || '', meta.po || '', meta.sdm || '', meta.gl || '',
         meta, resp, addl, pct, submissionId]
      );
    } else {
      const { rows } = await pool.query(
        `INSERT INTO submissions (product_name, customer, product_owner, sdm, go_live, meta, resp, addl, completion_pct)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [meta.pn || '', meta.cu || '', meta.po || '', meta.sdm || '', meta.gl || '',
         meta, resp, addl, pct]
      );
      submissionId = rows[0].id;
    }

    // 2. Send the email (only if SMTP is configured — see README).
    // This is intentionally isolated from the try/catch above: the database save has
    // already succeeded by this point, and an SMTP hiccup should never be reported
    // back to the user as a failed save.
    let emailSent = false;
    let emailError = null;
    try {
      const transport = buildTransport();
      if (transport) {
        await transport.sendMail({
          from: process.env.MAIL_FROM || process.env.SMTP_USER,
          to: MAIL_TO,
          subject: `Service Model Requirements Report — ${meta.pn || 'Untitled Product'} (${pct}% complete)`,
          html: reportHtml || '<p>No report content was provided.</p>',
        });
        emailSent = true;
      } else {
        console.warn('SMTP not configured — skipping email send. See README for setup.');
      }
    } catch (err) {
      console.error('Email send failed (submission was still saved):', err.message);
      emailError = err.message;
    }

    res.json({ ok: true, id: submissionId, completion_pct: pct, emailSent, emailError });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save submission' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Service Model Requirements Tracker running on port ${PORT}`));
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
