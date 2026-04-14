Backend Setup (God's Time Lodge)
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
