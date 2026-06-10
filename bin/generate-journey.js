#!/usr/bin/env node
process.argv.splice(2, 0, '--mode', 'generate-journey');
require('../index.js');
