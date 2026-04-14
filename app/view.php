<?php
declare(strict_types=1);

function view(string $path, array $data = []): void
{
    $fullPath = __DIR__ . '/../views/' . ltrim($path, '/');
    if (!is_file($fullPath)) {
        http_response_code(500);
        echo 'View not found';
        exit;
    }
    extract($data, EXTR_SKIP);
    require $fullPath;
}

