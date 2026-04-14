<?php
declare(strict_types=1);

require_once __DIR__ . '/../app/db.php';
require_once __DIR__ . '/../app/auth.php';
require_once __DIR__ . '/../app/view.php';

db_migrate();

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');

// Normalize trailing slash (except root).
if ($path !== '/' && str_ends_with($path, '/')) {
    header('Location: ' . rtrim($path, '/'), true, 302);
    exit;
}

function redirect(string $to): void
{
    header('Location: ' . $to);
    exit;
}

if ($path === '/') {
    $user = auth_user();
    if ($user === null) {
        redirect('/login');
    }
    if ($user['role'] === 'tenant') {
        redirect('/tenant/dashboard');
    }
    redirect('/admin/dashboard');
}

if ($path === '/login') {
    if ($method === 'POST') {
        $email = (string)($_POST['email'] ?? '');
        $password = (string)($_POST['password'] ?? '');
        $ok = auth_login($email, $password);
        if ($ok) {
            redirect('/');
        }
        view('auth/login.php', ['error' => 'Invalid email or password.']);
        exit;
    }
    view('auth/login.php', ['error' => null]);
    exit;
}

if ($path === '/register') {
    if ($method === 'POST') {
        try {
            $user = auth_register_tenant(
                (string)($_POST['full_name'] ?? ''),
                (string)($_POST['email'] ?? ''),
                (string)($_POST['password'] ?? ''),
                (string)($_POST['unit'] ?? '')
            );
            // Auto-login after registration.
            auth_login($user['email'], (string)($_POST['password'] ?? ''));
            redirect('/tenant/dashboard');
        } catch (RuntimeException $e) {
            view('auth/register.php', ['error' => $e->getMessage()]);
            exit;
        }
    }
    view('auth/register.php', ['error' => null]);
    exit;
}

if ($path === '/logout') {
    auth_logout();
    redirect('/login');
}

if ($path === '/tenant/dashboard') {
    auth_require_role('tenant');
    $user = auth_user();

    $pdo = db();
    $billsStmt = $pdo->prepare('SELECT id, bill_type, amount_kobo, due_date, status, created_at FROM bills WHERE user_id = :uid ORDER BY created_at DESC LIMIT 20');
    $billsStmt->execute([':uid' => (int)$user['id']]);
    $bills = $billsStmt->fetchAll();

    $paymentsStmt = $pdo->prepare('SELECT id, amount_kobo, status, reference, created_at FROM payments WHERE user_id = :uid ORDER BY created_at DESC LIMIT 20');
    $paymentsStmt->execute([':uid' => (int)$user['id']]);
    $payments = $paymentsStmt->fetchAll();

    $reqStmt = $pdo->prepare('SELECT id, issue, status, assigned_to, created_at FROM maintenance_requests WHERE user_id = :uid ORDER BY created_at DESC LIMIT 20');
    $reqStmt->execute([':uid' => (int)$user['id']]);
    $requests = $reqStmt->fetchAll();

    // Balance = sum of pending bills - sum of paid payments (demo).
    $totalBills = 0;
    foreach ($bills as $bill) {
        if (($bill['status'] ?? '') !== 'paid') {
            $totalBills += (int)$bill['amount_kobo'];
        }
    }
    $totalPayments = 0;
    foreach ($payments as $p) {
        if (($p['status'] ?? '') === 'paid') {
            $totalPayments += (int)$p['amount_kobo'];
        }
    }
    $balanceKobo = max(0, $totalBills - $totalPayments);

    view('tenant/dashboard.php', [
        'user' => $user,
        'bills' => $bills,
        'payments' => $payments,
        'requests' => $requests,
        'balance_kobo' => $balanceKobo,
    ]);
    exit;
}

if ($path === '/admin/dashboard') {
    auth_require_role('admin');
    // For now, keep admin dashboard as the static template page.
    // You can convert it to a dynamic view later.
    $file = __DIR__ . '/admin-dashboard.html';
    if (!is_file($file)) {
        http_response_code(500);
        echo 'Admin dashboard not set up yet.';
        exit;
    }
    readfile($file);
    exit;
}

http_response_code(404);
echo 'Not found';

