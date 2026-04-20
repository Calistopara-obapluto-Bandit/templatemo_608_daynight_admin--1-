Backend Setup (Godstime Lodge)
===============================

This folder now contains a small PHP + SQLite backend so tenants can register/login
and access only their own dashboard at:

  /tenant/dashboard

Key routes
----------
  /login
  /register
  /logout
  /tenant/dashboard   (tenant-only)
  /admin/dashboard    (admin-only)

Local run (PHP built-in server)
-------------------------------
From the project folder, run:

  php -S localhost:8000 -t public

Then open:
  http://localhost:8000/register

Admin user
----------
Create the first admin user by running:

  php app/seed_admin.php

Default credentials:
  admin@godstimelodge.com / admin123

Change the password after setup.

Deploy on Render
----------------
This repo can be deployed on Render as a Node Web Service using the Node app in:

  node-server.js

Files added for deployment:

  package.json
  render.yaml

Manual Render settings:

  Runtime: Node
  Plan: Free
  Build Command: npm ci && npm test
  Start Command: npm start
  Health Check Path: /healthz

Environment variable:

  NODE_ENV=production
  DATA_DIR=/tmp/godstime-lodge-data
  ADMIN_EMAIL=admin@godstimelodge.com
  ADMIN_PASSWORD=change-this-password
  COOKIE_SECURE=true

Important:
The app currently stores users in:

  data/node-db.json

On the free Render plan, the app stores this data in ephemeral storage at:

  /tmp/godstime-lodge-data/node-db.json

That means the demo is fine for testing and previewing, but data resets on redeploy or restart.

Production notes:
  - The server now exposes /healthz and checks that the data directory/database are readable.
  - Sessions and demo data are stored in ephemeral storage on the free plan, so they reset on restart or redeploy.
  - Startup logs no longer print the admin password.
  - Keep ADMIN_PASSWORD set to a strong secret in Render before first launch.

Tip:
The Blueprint now marks ADMIN_PASSWORD as a secret prompt in Render
(`sync: false`), so Render should ask for it during the first Blueprint setup.
If you skip it, the app falls back to the default admin password.

Deployment checklist
--------------------
Before pushing to Render, confirm:

  - `npm ci` succeeds locally.
  - `npm test` passes.
  - `render.yaml` keeps `buildCommand: npm ci && npm test`.
  - `render.yaml` keeps `startCommand: npm start`.
  - `render.yaml` keeps `healthCheckPath: /healthz`.
  - `render.yaml` keeps `plan: free` and uses ephemeral storage at `/tmp/godstime-lodge-data`.
  - `ADMIN_PASSWORD` is set to a secret value.
  - CircleCI uses `npm ci` instead of `npm install`.
