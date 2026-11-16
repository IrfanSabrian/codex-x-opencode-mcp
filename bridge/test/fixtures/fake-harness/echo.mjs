// Generic fixture: reports its argv and stdin as one JSON line, then exits.
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

process.stdout.write(`${JSON.stringify({
  argv: process.argv.slice(2),
  stdin: Buffer.concat(chunks).toString('utf8'),
  cwd: process.cwd()
})}\n`);
process.stderr.write('echo fixture stderr line\n');

process.exit(Number(process.env.ECHO_EXIT ?? 0));
