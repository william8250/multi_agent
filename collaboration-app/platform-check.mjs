import { probePlatforms } from './lib/platform-probe.mjs';
const args = process.argv.slice(2);
if (args.some(x => x !== '--model-probe') || args.length > 1) {
  console.error('Usage: node platform-check.mjs [--model-probe]');
  process.exitCode = 2;
} else console.log(JSON.stringify(await probePlatforms({ modelProbe: args.includes('--model-probe') }), null, 2));
