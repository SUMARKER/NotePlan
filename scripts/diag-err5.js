'use strict';
const fs = require('fs');
const path = require('path');
const s = fs.readFileSync(path.join(__dirname, '..', 'native-wpf', 'build-out.txt'), 'utf8');
const errs = [...new Set(s.split(/\r?\n/).filter((l) => l.includes('error')).map((l) => l.trim().slice(0, 220)))];
console.log(errs.length ? errs.join('\n---\n') : 'NO ERRORS');
