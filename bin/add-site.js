#!/usr/bin/env node
process.argv.splice(2, 0, '--mode', 'add-site');
require('../index.js');
