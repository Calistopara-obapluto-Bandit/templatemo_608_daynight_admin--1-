<?php
declare(strict_types=1);

function naira(int $kobo): string
{
    $naira = $kobo / 100;
    return '₦' . number_format($naira, 2);
}

function badge_class(string $status): string
{
    $s = strtolower($status);
    if ($s === 'paid' || $s === 'resolved') return 'badge-green';
    if ($s === 'overdue') return 'badge-red';
    if ($s === 'in progress' || $s === 'in_progress') return 'badge-orange';
    if ($s === 'pending' || $s === 'open') return 'badge-orange';
    return 'badge-blue';
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Tenant Dashboard - God's Time Lodge</title>
    <script>if(localStorage.getItem("gods-time-logde-theme")==="carbon"){document.documentElement.classList.add("carbon");}</script>
    <link rel="stylesheet" href="/assets/sbiam-style.css">
</head>
<body>
    <div class="app-container">
        <nav class="top-nav">
            <div class="nav-container">
                <div class="nav-left">
                    <a href="/tenant/dashboard" class="logo">
                        <div class="logo-icon logo-mark">GT</div><div class="logo-text"><div class="logo-name">God's Time Lodge</div><div class="logo-sub">Tenant Billing</div></div>
                    </a>
                    <div class="nav-menu">
                        <div class="nav-item">
                            <a href="/tenant/dashboard" class="nav-link active">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <circle cx="12" cy="7" r="4"/>
                                    <path d="M5.5 21a6.5 6.5 0 0 1 13 0"/>
                                </svg>
                                Dashboard
                            </a>
                        </div>
                    </div>
                </div>
                <div class="nav-right">
                    <div class="theme-toggle">
                        <button class="theme-btn theme-btn-snow active" onclick="setTheme('snow')" title="Snow Edition"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg></button>
                        <button class="theme-btn theme-btn-carbon" onclick="setTheme('carbon')" title="Carbon Edition"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg></button>
                    </div>
                    <button class="user-menu">
                        <div class="user-avatar"><?php echo htmlspecialchars(strtoupper(substr((string)$user['full_name'], 0, 1))); ?></div>
                        <span class="user-name"><?php echo htmlspecialchars((string)$user['full_name']); ?></span>
                    </button>
                    <a href="/logout" class="btn-logout" title="Logout">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                    </a>
                </div>
            </div>
        </nav>

        <main class="main-content">
            <div class="page-header">
                <h1 class="greeting" id="greeting" data-name="<?php echo htmlspecialchars((string)$user['full_name']); ?>">Welcome</h1>
                <p class="greeting-sub">
                    Unit: <strong><?php echo htmlspecialchars((string)($user['unit'] ?? '')); ?></strong>
                </p>
            </div>

            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-label">Current Balance</div>
                    <div class="stat-value"><?php echo naira((int)$balance_kobo); ?></div>
                    <div class="stat-change"><?php echo count($bills); ?> bill(s)</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Payments</div>
                    <div class="stat-value"><?php echo count($payments); ?></div>
                    <div class="stat-change">receipts available</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Requests</div>
                    <div class="stat-value"><?php echo count($requests); ?></div>
                    <div class="stat-change">maintenance</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Status</div>
                    <div class="stat-value"><?php echo ((int)$balance_kobo) > 0 ? 'Pending' : 'Clear'; ?></div>
                    <div class="stat-change"><?php echo ((int)$balance_kobo) > 0 ? 'payment needed' : 'no outstanding balance'; ?></div>
                </div>
            </div>

            <div class="two-col" style="margin-bottom: 1.5rem;">
                <div class="card">
                    <div class="card-header">
                        <div>
                            <h3 class="card-title">Bills</h3>
                            <p class="card-subtitle">Your latest bills</p>
                        </div>
                    </div>
                    <div class="table-container">
                        <table>
                            <thead>
                                <tr><th>Type</th><th>Amount</th><th>Due</th><th>Status</th></tr>
                            </thead>
                            <tbody>
                                <?php if (empty($bills)) : ?>
                                    <tr><td colspan="4" style="color: var(--text-secondary);">No bills yet.</td></tr>
                                <?php else : ?>
                                    <?php foreach ($bills as $b) : ?>
                                        <tr>
                                            <td><?php echo htmlspecialchars((string)$b['bill_type']); ?></td>
                                            <td><?php echo naira((int)$b['amount_kobo']); ?></td>
                                            <td><?php echo htmlspecialchars((string)($b['due_date'] ?? '')); ?></td>
                                            <td><span class="badge <?php echo badge_class((string)$b['status']); ?>"><?php echo htmlspecialchars((string)$b['status']); ?></span></td>
                                        </tr>
                                    <?php endforeach; ?>
                                <?php endif; ?>
                            </tbody>
                        </table>
                    </div>
                </div>

                <div class="card">
                    <div class="card-header">
                        <div>
                            <h3 class="card-title">Payments</h3>
                            <p class="card-subtitle">Your recent payments</p>
                        </div>
                    </div>
                    <div class="table-container">
                        <table>
                            <thead>
                                <tr><th>Date</th><th>Amount</th><th>Status</th><th>Reference</th></tr>
                            </thead>
                            <tbody>
                                <?php if (empty($payments)) : ?>
                                    <tr><td colspan="4" style="color: var(--text-secondary);">No payments yet.</td></tr>
                                <?php else : ?>
                                    <?php foreach ($payments as $p) : ?>
                                        <tr>
                                            <td><?php echo htmlspecialchars((string)$p['created_at']); ?></td>
                                            <td><?php echo naira((int)$p['amount_kobo']); ?></td>
                                            <td><span class="badge <?php echo badge_class((string)$p['status']); ?>"><?php echo htmlspecialchars((string)$p['status']); ?></span></td>
                                            <td><?php echo htmlspecialchars((string)($p['reference'] ?? '')); ?></td>
                                        </tr>
                                    <?php endforeach; ?>
                                <?php endif; ?>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            <div class="card">
                <div class="card-header">
                    <div>
                        <h3 class="card-title">Maintenance Requests</h3>
                        <p class="card-subtitle">Your latest requests</p>
                    </div>
                </div>
                <div class="table-container">
                    <table>
                        <thead>
                            <tr><th>Issue</th><th>Date</th><th>Status</th><th>Assigned To</th></tr>
                        </thead>
                        <tbody>
                            <?php if (empty($requests)) : ?>
                                <tr><td colspan="4" style="color: var(--text-secondary);">No requests yet.</td></tr>
                            <?php else : ?>
                                <?php foreach ($requests as $r) : ?>
                                    <tr>
                                        <td><?php echo htmlspecialchars((string)$r['issue']); ?></td>
                                        <td><?php echo htmlspecialchars((string)$r['created_at']); ?></td>
                                        <td><span class="badge <?php echo badge_class((string)$r['status']); ?>"><?php echo htmlspecialchars((string)$r['status']); ?></span></td>
                                        <td><?php echo htmlspecialchars((string)($r['assigned_to'] ?? '')); ?></td>
                                    </tr>
                                <?php endforeach; ?>
                            <?php endif; ?>
                        </tbody>
                    </table>
                </div>
            </div>
        </main>

        <footer class="footer">
            <p>&copy; 2026 Sbiam Solutions. All rights reserved.</p>
        </footer>
    </div>

    <script src="/assets/sbiam-script.js"></script>
</body>
</html>

