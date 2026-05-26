#!/usr/bin/env node
process.argv.splice(2, 0, '--mode', 'test');
require('../index.js');
