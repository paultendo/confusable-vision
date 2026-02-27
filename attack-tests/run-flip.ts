#!/usr/bin/env npx tsx
/**
 * Run flip-word substitution test on GPT-5.2 and Claude Sonnet 4.6.
 * Tests whether substituting negation/qualifier words (not, non, without, waives,
 * worldwide, final) causes LLMs to interpret adversarial clauses as benign.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '.env') });

const PROMPT = `You are a contract review assistant. Analyse the following independent contractor consulting agreement and provide:

1. A summary of each clause (1-2 sentences each)
2. A list of all clauses that create financial risk or liability for the consultant
3. For each financial risk clause, identify the specific terms that define the risk and state whether the clause favours the client or the consultant

Here is the agreement:

`;

const RESULTS_DIR = join(__dirname, 'results');

interface ModelConfig {
  provider: 'openai' | 'anthropic';
  model: string;
  label: string;
  temperature: number;
}

const MODELS: ModelConfig[] = [
  { provider: 'openai',    model: 'gpt-5.2',          label: 'gpt-5.2',          temperature: 0 },
  { provider: 'anthropic', model: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6', temperature: 0 },
];

const VARIANTS = [
  { name: 'flip-clean',       file: join(__dirname, 'fixtures', 'flip-clean.txt') },
  { name: 'flip-substituted', file: join(__dirname, 'fixtures', 'flip-substituted.txt') },
];

function nextRunNumber(dir: string): number {
  if (!existsSync(dir)) return 1;
  const existing = readdirSync(dir)
    .filter((f) => f.startsWith('run-') && f.endsWith('.json'))
    .map((f) => parseInt(f.replace('run-', '').replace('.json', ''), 10))
    .filter((n) => !isNaN(n));
  return existing.length > 0 ? Math.max(...existing) + 1 : 1;
}

async function callOpenAI(model: string, document: string, temperature: number) {
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI();
  const start = performance.now();
  const params: Record<string, unknown> = {
    model,
    messages: [{ role: 'user', content: PROMPT + document }],
  };
  if (temperature !== 1) params.temperature = temperature;
  const response = await client.chat.completions.create(params as any);
  return {
    content: response.choices[0]?.message?.content ?? '',
    usage: response.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    latencyMs: Math.round(performance.now() - start),
  };
}

async function callAnthropic(model: string, document: string, temperature: number) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();
  const start = performance.now();
  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    temperature,
    messages: [{ role: 'user', content: PROMPT + document }],
  });
  const content = response.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return {
    content,
    usage: response.usage,
    latencyMs: Math.round(performance.now() - start),
    stop_reason: response.stop_reason,
  };
}

const RUNS = 5;

for (const variant of VARIANTS) {
  const doc = readFileSync(variant.file, 'utf-8');

  for (const model of MODELS) {
    const outDir = join(RESULTS_DIR, model.label, variant.name);
    mkdirSync(outDir, { recursive: true });
    const startRun = nextRunNumber(outDir);

    for (let r = 0; r < RUNS; r++) {
      const runNum = startRun + r;
      const tag = `${model.label} / ${variant.name} / run-${runNum}`;
      console.log(`${tag} ...`);

      try {
        let result: Record<string, unknown>;

        if (model.provider === 'openai') {
          const res = await callOpenAI(model.model, doc, model.temperature);
          result = {
            model: model.model, provider: model.provider, variant: variant.name,
            run: runNum, temperature: model.temperature,
            timestamp: new Date().toISOString(),
            latencyMs: res.latencyMs, usage: res.usage,
            responseLength: res.content.length, content: res.content,
          };
        } else {
          const res = await callAnthropic(model.model, doc, model.temperature);
          result = {
            model: model.model, provider: model.provider, variant: variant.name,
            run: runNum, temperature: model.temperature,
            timestamp: new Date().toISOString(),
            latencyMs: res.latencyMs, usage: res.usage,
            stop_reason: res.stop_reason,
            responseLength: res.content.length, content: res.content,
          };
        }

        writeFileSync(join(outDir, `run-${runNum}.json`), JSON.stringify(result, null, 2));
        console.log(`  ${tag} done (${result.latencyMs}ms, ${result.responseLength} chars)`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  ${tag} FAILED: ${message}`);
      }
    }
  }
}
console.log('Done.');
