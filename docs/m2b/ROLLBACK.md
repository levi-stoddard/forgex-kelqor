# Rolling back Milestone 2B

Each part can be rolled back on its own. Close KELQOR first: the embedded database can be open in one program only.

## The app

Run the kept 0.1.3 installer, `desktop\out\kept-installers\KELQOR-Setup-0.1.3.exe`. Installing an older version over a
newer one replaces it; your settings and the encrypted session in `%APPDATA%\KELQOR` stay.

## The code

In the project folder, switch back to the 0.1.3 code:

```bash
git switch kelqor/desktop-m1
```

The installed app's backend runs from that folder, so after this the app runs the 0.1.3 code again. M2B stays on the
local branch `kelqor/m2b`; nothing was pushed.

## The database

Either restore the backup taken just before migration 0004, or undo the migrations in place.

**Restore the backup** (everything you recorded after the backup is lost):

1. Close KELQOR.
2. Rename `.data\pglite` to `.data\pglite-after-m2b`. Nothing is deleted.
3. Copy `.data\pglite-backup-<date>-pre-m2b` to `.data\pglite`, then delete the copied `BACKUP.json` inside it.

**Undo the migrations in place** (keeps everything else you recorded after the backup): `docs/m2b/rollback.sql` drops
the nine M2B tables, the two `users` columns with their index and check, the functions migration 0005 created, and the
two migration records. Dropping `users.sign_in_disabled_at` turns demo sign-in back on. Run it with:

```bash
npm run db:rollback-m2b -- --confirm
```

It refuses while the backend runs, and it runs in one transaction: either all of it applies or none of it.
