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
  Build Command: npm install
  Start Command: npm start
  Health Check Path: /healthz
  Plan: Starter or higher

Persistent disk settings:

  Mount Path: /var/data
  Size: 1 GB

Environment variable:

  NODE_ENV=production
  DATA_DIR=/var/data
  ADMIN_EMAIL=admin@godstimelodge.com
  ADMIN_PASSWORD=change-this-password
  COOKIE_SECURE=true

Important:
The app currently stores users in:

  data/node-db.json

In Render, the app is now configured to store this data on the mounted disk at:

  /var/data/node-db.json

If you remove the disk, the app falls back to the local ./data folder again.

Production notes:
  - The server now exposes /healthz and checks that the data directory/database are readable.
  - Sessions are stored in the same persistent data file, so logins survive service restarts.
  - Startup logs no longer print the admin password.
  - Keep ADMIN_PASSWORD set to a strong secret in Render before first launch.

Tip:
The Blueprint now marks ADMIN_PASSWORD as a secret prompt in Render
(`sync: false`), so Render should ask for it during the first Blueprint setup.
If you skip it, the app falls back to the default admin password.
