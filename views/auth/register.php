<?php
declare(strict_types=1);
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Create Tenant Account - God's Time Lodge</title>
    <link rel="stylesheet" href="/assets/sbiam-style.css">
</head>
<body>
    <div class="login-page">
        <div class="login-container">
            <div class="login-card">
                <div class="login-header">
                    <div class="login-logo">
                        <div class="logo-icon logo-mark">GT</div>
                        <div class="logo-text">
                            <div class="logo-name">God's Time Lodge</div>
                            <div class="logo-sub">Tenant Billing</div>
                        </div>
                    </div>
                    <h1 class="login-title">Create tenant account</h1>
                    <p class="login-subtitle">Register to access your dashboard.</p>
                </div>

                <?php if (!empty($error)) : ?>
                    <div class="alert alert-error" style="margin-bottom: 1rem;">
                        <?php echo htmlspecialchars((string)$error); ?>
                    </div>
                <?php endif; ?>

                <form class="login-form" method="post" action="/register">
                    <div class="form-group">
                        <label class="form-label">Full Name</label>
                        <input name="full_name" type="text" class="form-input" placeholder="e.g. Adaeze Okafor" required>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Unit</label>
                        <input name="unit" type="text" class="form-input" placeholder="e.g. Block B - 3">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Email Address</label>
                        <input name="email" type="email" class="form-input" placeholder="you@example.com" required>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Password</label>
                        <input name="password" type="password" class="form-input" placeholder="Minimum 6 characters" required>
                    </div>
                    <button type="submit" class="btn btn-primary">Create Account</button>
                </form>

                <p class="login-footer" style="margin-top: 1rem;">
                    Already registered? <a href="/login">Sign in</a>
                </p>
            </div>

            <p style="text-align: center; margin-top: 1.5rem; font-size: 0.8125rem; color: var(--text-secondary);">
                &copy; 2026 Sbiam Solutions. All rights reserved.
            </p>
        </div>
    </div>
</body>
</html>

