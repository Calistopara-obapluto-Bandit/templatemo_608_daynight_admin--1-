<?php
declare(strict_types=1);

require_once __DIR__ . '/db.php';

function auth_start_session(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }

    // Basic hardening for cookie sessions.
    ini_set('session.use_strict_mode', '1');
    ini_set('session.cookie_httponly', '1');
    ini_set('session.cookie_samesite', 'Lax');

    session_start();
}

function auth_user(): ?array
{
    auth_start_session();
    if (!isset($_SESSION['user_id'])) {
        return null;
    }

    $pdo = db();
    $stmt = $pdo->prepare('SELECT id, email, role, full_name, unit FROM users WHERE id = :id');
    $stmt->execute([':id' => (int)$_SESSION['user_id']]);
    $user = $stmt->fetch();

    return $user ?: null;
}

function auth_login(string $email, string $password): bool
{
    auth_start_session();
    $pdo = db();
    $stmt = $pdo->prepare('SELECT id, password_hash FROM users WHERE email = :email');
    $stmt->execute([':email' => $email]);
    $row = $stmt->fetch();
    if (!$row) {
        return false;
    }

    if (!password_verify($password, (string)$row['password_hash'])) {
        return false;
    }

    $_SESSION['user_id'] = (int)$row['id'];
    return true;
}

function auth_logout(): void
{
    auth_start_session();
    $_SESSION = [];
    session_destroy();
}

function auth_require_login(): void
{
    if (auth_user() === null) {
        header('Location: /login');
        exit;
    }
}

function auth_require_role(string $role): void
{
    $user = auth_user();
    if ($user === null) {
        header('Location: /login');
        exit;
    }
    if (($user['role'] ?? '') !== $role) {
        http_response_code(403);
        echo 'Forbidden';
        exit;
    }
}

function auth_register_tenant(string $fullName, string $email, string $password, string $unit): array
{
    $email = trim(strtolower($email));
    $fullName = trim($fullName);
    $unit = trim($unit);

    if ($fullName === '' || $email === '' || $password === '') {
        throw new RuntimeException('Missing required fields.');
    }
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        throw new RuntimeException('Invalid email address.');
    }
    if (strlen($password) < 6) {
        throw new RuntimeException('Password must be at least 6 characters.');
    }

    $pdo = db();
    $stmt = $pdo->prepare(
        'INSERT INTO users (email, password_hash, role, full_name, unit)
         VALUES (:email, :hash, :role, :name, :unit)'
    );

    $hash = password_hash($password, PASSWORD_DEFAULT);

    try {
        $stmt->execute([
            ':email' => $email,
            ':hash' => $hash,
            ':role' => 'tenant',
            ':name' => $fullName,
            ':unit' => $unit !== '' ? $unit : null,
        ]);
    } catch (PDOException $e) {
        // Likely duplicate email.
        throw new RuntimeException('This email is already registered.');
    }

    $userId = (int)$pdo->lastInsertId();
    return [
        'id' => $userId,
        'email' => $email,
        'role' => 'tenant',
        'full_name' => $fullName,
        'unit' => $unit,
    ];
}

