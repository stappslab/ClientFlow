# ClientFlow

A responsive project-management demo with customizable Kanban boards and a
separate client-facing project portal.

## Development

Requires Node.js 22.18+ and npm.

```sh
npm ci
npm run dev
```

Open the localhost URL printed by Vite. Choose **Open local demo** to use
browser-local data without a Firebase account. Demo members and plan controls
are simulations; the local demo does not send invitation emails or take payments.

## Firebase Configuration

For a connected workspace, create an ignored `.env.local` using `.env.example`
and supply all six `VITE_FIREBASE_*` values from your own Firebase web app.
Enable the required Authentication providers and configure authorized domains.
Never place service-account keys or server secrets in frontend environment values:
every `VITE_*` value is public in the browser bundle.

Without configuration, only demo identifiers are used. Partial configuration
is rejected; there is no fallback to another live project.

The backend is in `functions/`, with Firestore rules and indexes at the root.
Install its dependencies with `npm ci --prefix functions`. Server-mode workspaces
require Functions, indexes and matching rules to be deployed together. Review
data migrations and backups before enabling `VITE_SERVER_MODE=true` on existing
data. Deployment is not part of running the local demo.

SMTP delivery requires separately configured server-side credentials. Billing is
not integrated. Production use requires your own security and deployment review.

## Verification

```sh
npm run build
npm test
node scripts/test-rules.mjs
node scripts/test-server.mjs
```

Emulator suites use `demo-clientflow`, not a live project, and require Java 21+.
On Windows, `node scripts/setup-test-java.mjs` prepares an ignored local runtime.
Browser tests require Playwright Chromium (`npx playwright install chromium`).

With the development server running on port 5173:

```sh
node tests/browser.mjs
node tests/touch.mjs
node tests/performance.mjs
```

Features include drag-and-drop tasks, deadlines, comments and change suggestions,
member permissions, client-visible task filtering, revocable public links,
project export/restore, and virtualized large columns. Cloud integration tests
exercise invitations, concurrent edits, guest feedback and email-outbox safety.

## Repository Safety

Local environment files, Firebase project aliases, private planning documents,
PDFs, backups, logs, generated bundles and test artifacts are excluded from Git.
Run `node scripts/check-public.mjs` after staging changes and before publishing.
This check supplements manual review; it cannot detect every possible secret.
