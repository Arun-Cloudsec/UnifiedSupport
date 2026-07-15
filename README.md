# Service Model Requirements Tracker

Internal tool for scoping service model requirements per product/customer,
with database storage and an automated report email whenever a report is generated.

- **Frontend:** single page in `public/index.html` (vanilla JS, no build step), gated by an access code
- **Backend:** `server.js` — Express API for storage + email
- **Database:** PostgreSQL (Railway's Postgres plugin works out of the box)
- **Email:** sent via SMTP (any provider) whenever "Generate Report" is used

## What happens when you click "Generate Report"

1. The report is rendered on screen immediately.
2. In the background, the full submission (product name, customer, all requirement
   statuses/notes) is saved to Postgres.
3. The same report is emailed to `arun.vivek@gmail.com` (configurable) as the email body.
4. A status line under the report tells you whether the save/email succeeded — a save
   always succeeds independently of email delivery, so a bad SMTP setting never loses data.

## Deploying to Railway

1. Push this folder to a GitHub repo (or use `railway up` from this folder directly).
2. In Railway, create a new project from that repo.
3. **Add a PostgreSQL plugin** to the project — Railway automatically injects
   `DATABASE_URL` into your service, no manual config needed.
4. Set the following environment variables on the service (Railway → Variables):

   | Variable | Required | Notes |
   |---|---|---|
   | `MAIL_TO` | No | Defaults to `arun.vivek@gmail.com` if unset |
   | `SMTP_HOST` | For email | e.g. `smtp.gmail.com` |
   | `SMTP_PORT` | For email | e.g. `587` |
   | `SMTP_SECURE` | For email | `true` for port 465, otherwise `false` |
   | `SMTP_USER` | For email | Your sending address |
   | `SMTP_PASS` | For email | An **app password**, never your real account password |
   | `MAIL_FROM` | No | Defaults to `SMTP_USER` |

   If you skip the `SMTP_*` variables, the app still works fully — reports are saved
   to the database and shown on screen, the status line just says the email wasn't sent.

5. Railway auto-detects Node from `package.json` and runs `npm start`. No `Procfile` needed.
6. Once deployed, open the app URL and log in with the access code (`625244` by default —
   change it in `public/index.html` if you want a different code, since it's checked
   client-side).

### Getting a Gmail app password (if using Gmail as the sender)
Gmail no longer accepts your normal password for SMTP. Generate one at
[myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) (requires
2-Step Verification to be on) and use that 16-character value as `SMTP_PASS`.

## Local development

```bash
npm install
cp .env.example .env      # then fill in DATABASE_URL (and SMTP_* if you want email)
npm start                 # runs on http://localhost:3000
```

## Data model

Each submission is one row in the `submissions` table:

| Column | Meaning |
|---|---|
| `product_name`, `customer`, `product_owner`, `sdm`, `go_live` | Pulled from the top meta fields, duplicated as plain columns for easy querying |
| `meta`, `resp`, `addl` | Full JSON state — every requirement's status/value/notes, category notes |
| `completion_pct` | Computed server-side from `resp`, not trusted from the client |

Use **Save to Database** any time to save progress without emailing. Use **Load from
Database** to browse and reopen any past submission. **Generate Report** does both a
save and an email in one step.
