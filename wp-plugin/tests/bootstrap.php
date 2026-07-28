<?php

declare(strict_types=1);

// Unit tests exercise only the pure, WordPress-free static methods of the
// plugin's classes, so the composer autoloader is the whole bootstrap. The
// `use const BeardbotSensors\…` imports in those classes resolve lazily and are
// never referenced from the pure methods under test.
require_once __DIR__ . '/../vendor/autoload.php';
