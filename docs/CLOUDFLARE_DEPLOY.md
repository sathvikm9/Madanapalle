# Cloudflare Worker and D1 deployment

The Worker is the always-online API and D1 is the database. Neither accesses BookMyShow; only the local Chrome extension does that.

## Requirements

- a free Cloudflare account
- Node.js 22 or newer (`nvm use` reads the repository's `.nvmrc`)
- Wrangler authentication (`npx wrangler whoami`)

## First deployment

1. Authenticate:

   ```bash
   npx wrangler login
   npx wrangler whoami
   ```

2. Create the free D1 database:

   ```bash
   cd apps/worker
   npx wrangler d1 create sri-krishna-tracker
   ```

3. Copy the returned `database_id` into `apps/worker/wrangler.jsonc`, replacing the all-zero development ID.

4. Change `CORS_ORIGINS` in `wrangler.jsonc` to the exact dashboard origin, for example `https://YOUR-NAME.github.io`.

5. Generate one long token and store it as a Worker secret. Save the same value for the Chrome extension settings.

   ```bash
   openssl rand -hex 32
   npx wrangler secret put AGENT_TOKEN
   ```

6. Apply the schema and deploy:

   ```bash
   npx wrangler d1 migrations apply sri-krishna-tracker --remote
   npx wrangler deploy
   ```

7. Open the displayed `workers.dev` URL with `/health`. It should return `ok: true`.

8. Put that Worker URL and the shared token into the Chrome extension, then run **Save and test now**.

## Local development

```bash
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
npm run worker:migrate:local
npm run dev
```

The Worker runs locally on port 8787 and the dashboard on port 5173. Local and remote D1 databases are separate.

## Data protection and recovery

- `AGENT_TOKEN` must remain a Worker secret; never commit it or put it in the dashboard.
- Public dashboard reads do not expose the token.
- Export periodic backups with `npx wrangler d1 export sri-krishna-tracker --remote --output=backup.sql`.
- D1 finalization is idempotent. Its one-minute cron only marks the newest received final-window snapshot as final; it never contacts BookMyShow.
