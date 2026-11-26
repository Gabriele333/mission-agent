#!/usr/bin/env node
import { main } from './cli/main.js';

const code = await main(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin });
process.exitCode = code;
