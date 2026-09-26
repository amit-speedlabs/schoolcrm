# Deploying to Render + Supabase

This puts the CRM on a public HTTPS link like `https://glf-crm.onrender.com`, backed by a Supabase Postgres database.
Both have free tiers. The repo already contains everything Render needs (`render.yaml`); you only create the two
accounts and paste in a few values. Database tables are created automatically the first time the app starts.
No demo data is loaded.

## 1. Create the database (Supabase)

1. Sign up at https://supabase.com and click **New project**.
2. Name it `glf-crm`, set a **Database password** (save it somewhere safe), and pick region **South Asia (Mumbai)**.
   Click **Create new project** and wait a minute or two.
3. Click **Connect** at the top of the project page.
4. Under **Connection string**, choose type **URI** and the **Session pooler** row. Copy the string. It looks like:
   ```
   postgresql://postgres.abcdefghijkl:[YOUR-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
   ```
5. Replace `[YOUR-PASSWORD]` with the password from step 2. If the password contains characters such as `@ : / # ? %`,
   either choose a password without them or URL-encode them (for example `@` becomes `%40`).

Use the **Session pooler** string, not "Direct connection" (IPv6 only, which Render cannot reach) and not
"Transaction pooler" (port 6543, which breaks the sync lock the app uses).

## 2. Create the web service (Render)

1. Sign up at https://render.com with **GitHub** and allow Render to access the `amit-speedlabs/schoolcrm` repository.
2. In the Render dashboard click **New → Blueprint**, pick the `schoolcrm` repository, branch `main`.
3. Render reads `render.yaml` and asks for the secret values:

| Variable | What to enter |
|---|---|
| `DATABASE_URL` | the Session pooler string from step 1.5 |
| `ADMIN_EMAIL` | your login email for the CRM |
| `ADMIN_PASSWORD` | a strong password for that login |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | leave empty for now (see step 4) |

4. Click **Apply**. The first build and start take a few minutes. When the service shows **Live**, its URL is at the top
   of the service page (`https://glf-crm.onrender.com`, or with a suffix if that name is taken).
5. Open the URL and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`. That admin is created only on the first start, so
   changing these variables later does not change the password; manage users under **Users** instead.

Add more people (for example management with view-only access) under **Users** in the app.

## 3. Check it is healthy

`https://<your-url>/healthz` should return `{"ok":true}`. If the service fails to start, open **Logs** in Render:
- `password authentication failed` or `Tenant or user not found`: the `DATABASE_URL` is wrong (password not replaced,
  or the Direct connection string was used). Fix it under **Environment** and Render redeploys.
- `self-signed certificate` / SSL errors: make sure `DATABASE_SSL` is `true`.

## 4. Connect Google Sheets (when ready)

Follow [GOOGLE_SETUP.md](GOOGLE_SETUP.md) to create the service account, then in Render go to the service's
**Environment**, set `GOOGLE_SERVICE_ACCOUNT_JSON` to the key file's contents, and save (Render redeploys). Then add the
sheets under **Integrations** in the CRM.

## Free tier limits worth knowing

- **Render free** puts the service to sleep after 15 minutes without visits. The next visit takes about a minute to wake
  it, and automatic sheet syncing does not run while it sleeps (it catches up when it wakes; **Sync now** always works).
  To keep it always on, change the instance type to **Starter** under the service's **Settings**.
- **Supabase free** pauses a project after a week with no database activity; resume it from the Supabase dashboard.
  A paid plan also adds daily backups.

## Updating

Every push to `main` redeploys automatically. New migrations in `migrations/` are applied on start.
Run only one instance: the scheduler runs inside the web process.
