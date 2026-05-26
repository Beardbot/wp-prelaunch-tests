#!/usr/bin/env node
process.argv.splice(2, 0, '--mode', 'baseline');
require('../index.js');
