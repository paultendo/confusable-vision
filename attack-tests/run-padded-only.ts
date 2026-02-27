#!/usr/bin/env npx tsx
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '.env') });

const { default: OpenAI } = await import('openai');
const client = new OpenAI();

const PROMPT = `You are a contract review assistant. Analyse the following SaaS licence agreement and provide:

1. A summary of each clause (1-2 sentences each)
2. A list of all clauses that create financial risk or liability for the licensee
3. For each financial risk clause, identify the specific terms that define the risk

Here is the agreement:

`;

const variants = [
  { name: 'consulting-padded-clean', file: join(__dirname, 'fixtures', 'consulting-padded-clean.txt') },
  { name: 'consulting-padded-heavy', file: join(__dirname, 'fixtures', 'consulting-padded-heavy.txt') },
];

for (const v of variants) {
  const doc = readFileSync(v.file, 'utf-8');
  const outDir = join(__dirname, 'results', 'gpt-5.2', v.name);
  mkdirSync(outDir, { recursive: true });

  for (let run = 1; run <= 5; run++) {
    const tag = `gpt-5.2 / ${v.name} / run-${run}`;
    console.log(`${tag} ...`);
    const start = performance.now();
    const res = await client.chat.completions.create({
      model: 'gpt-5.2',
      temperature: 0,
      messages: [{ role: 'user', content: PROMPT + doc }],
    });
    const ms = Math.round(performance.now() - start);
    const content = res.choices[0]?.message?.content ?? '';
    writeFileSync(join(outDir, `run-${run}.json`), JSON.stringify({
      model: 'gpt-5.2', provider: 'openai', variant: v.name, run,
      temperature: 0, timestamp: new Date().toISOString(),
      latencyMs: ms, usage: res.usage, responseLength: content.length, content,
    }, null, 2));
    console.log(`  ${tag} done (${ms}ms, ${content.length} chars)`);
  }
}
console.log('Done.');
