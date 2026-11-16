// One-shot fixture for spawn timeout/cancel tests: announces itself, then sleeps.
process.stdout.write('sleeping\n');

if (process.env.FAKE_SLEEP_IGNORE_SIGTERM === '1') {
  process.on('SIGTERM', () => {});
}

setTimeout(() => process.exit(0), 120_000);
