const { spawn } = require('child_process');
const path = require('path');

// Test script to manually start llama-server
const serverPath = path.join(__dirname, 'src/main/bin/llama-server.exe');
const modelPath = process.argv[2]; // Pass model path as argument

if (!modelPath) {
  console.log('Usage: node test-server.js <path-to-model.gguf>');
  process.exit(1);
}

console.log('Testing llama-server startup...');
console.log('Server path:', serverPath);
console.log('Model path:', modelPath);

const args = [
  '-m', modelPath,
  '-c', '2048',
  '--port', '8080',
  '--host', '0.0.0.0',
  '--cache-ram', '0'
];

console.log('Arguments:', args.join(' '));

const serverProcess = spawn(serverPath, args);

serverProcess.stdout.on('data', (data) => {
  console.log('[STDOUT]', data.toString());
});

serverProcess.stderr.on('data', (data) => {
  console.log('[STDERR]', data.toString());
});

serverProcess.on('error', (err) => {
  console.log('[ERROR]', err.message);
});

serverProcess.on('close', (code) => {
  console.log(`[CLOSE] Process exited with code ${code}`);
});

// Keep the process alive for 10 seconds to see output
setTimeout(() => {
  console.log('Stopping test...');
  serverProcess.kill();
  process.exit(0);
}, 10000);