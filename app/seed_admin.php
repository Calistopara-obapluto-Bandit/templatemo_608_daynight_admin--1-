<?php
declare(strict_types=1);

require_once __DIR__ . '/db.php';

db_migrate();
$pdo = db();

$email = 'admin@godstimelodge.com';
$password = 'admin123';
$fullName = 'Admin';

$exists = (int)$pdo->query("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'")->fetch()['c'];
if ($exists > 0) {
    echo "Admin already exists.\n";
    exit(0);
}

$stmt = $pdo->prepare(
    'INSERT INTO users (email, password_hash, role, full_name, unit)
     VALUES (:email, :hash, :role, :name, :unit)'
);
$stmt->execute([
    ':email' => $email,
    ':hash' => password_hash($password, PASSWORD_DEFAULT),
    ':role' => 'admin',
    ':name' => $fullName,
    ':unit' => null,
]);

echo "Seeded admin user:\n";
echo "  Email: {$email}\n";
echo "  Password: {$password}\n";

